/**
 * CompanyStore: durable storage for one canonical workspace.
 *
 * Layout under `~/.pixel-agents/company/<sha256(canonicalWorkspace)>/`:
 *
 *   events.jsonl   append-only journal of committed CompanyEvents (authority)
 *   state.json     snapshot of the state as of the last commit (cache)
 *   artifacts/     opaque bytes addressed by UUID: prompts, diffs, logs
 *
 * Durability rules, in the order they matter:
 *  1. An artifact is fsynced before any event references it, so a committed
 *     event never points at bytes that are not on disk.
 *  2. The journal line is appended and fsynced before the snapshot, so a crash
 *     between the two loses only the cache, never a commit.
 *  3. A torn final line (crash mid-append) is preserved verbatim as a recovery
 *     artifact and the journal is truncated to the last complete newline --
 *     the bytes are never dropped and a new event is never appended onto a
 *     partial record.
 *  4. A malformed COMPLETE record fails closed as `company_store_corrupt`; a
 *     corrupt journal is never reset, because a reset would silently discard
 *     committed history.
 *
 * `load()` is idempotent; `commit()` serializes through a single in-process
 * queue so two callers cannot interleave a journal append with a snapshot
 * write.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ArtifactPage, CompanyEvent, CompanyState } from '../../../core/src/company.js';
import { LAYOUT_FILE_DIR } from '../constants.js';
import { toPathKey } from '../pathKey.js';
import { CompanyError } from './companyError.js';
import { applyCompanyEvent, createInitialCompanyState } from './companyState.js';
import {
  COMPANY_ARTIFACT_BODY_SUFFIX,
  COMPANY_ARTIFACT_DIR,
  COMPANY_ARTIFACT_ID_PATTERN,
  COMPANY_ARTIFACT_META_SUFFIX,
  COMPANY_ARTIFACT_PAGE_BYTES,
  COMPANY_JOURNAL_FILE,
  COMPANY_STATE_DIR,
  COMPANY_STATE_FILE,
} from './constants.js';
import type { CompanyModelResolution } from './hostModelRoles.js';

interface JournalReadResult {
  events: CompanyEvent[];
  /** Trailing bytes of an interrupted final record, preserved verbatim. */
  tornTail?: Buffer;
}

/**
 * Resolve a workspace to its real path and its identity key. The two differ:
 * `realPath` is what settings report to the user, while `key` is folded so two
 * spellings of the same directory share one namespace.
 */
export async function canonicalizeWorkspace(workspacePath: string): Promise<{
  realPath: string;
  key: string;
}> {
  if (!workspacePath.trim()) {
    throw new CompanyError('invalid_workspace', 'Workspace path is empty.');
  }
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(workspacePath);
  } catch (err) {
    throw new CompanyError('invalid_workspace', `Workspace does not exist: ${workspacePath}`, {
      cause: err,
    });
  }
  const stats = await fs.promises.stat(realPath);
  if (!stats.isDirectory()) {
    throw new CompanyError('invalid_workspace', `Workspace is not a directory: ${workspacePath}`);
  }
  // One definition of path identity: the repo's `toPathKey` resolves and folds
  // case on Windows. macOS volumes are case-insensitive too but its tooling
  // does not lowercase spellings the way Windows does, so an ownership lock
  // there needs the fold applied explicitly -- otherwise two spellings of one
  // directory would open two company namespaces and two coordinators.
  const resolvedKey = toPathKey(realPath);
  const key = process.platform === 'darwin' ? resolvedKey.toLowerCase() : resolvedKey;
  return { realPath, key };
}

/** Identity key only, for callers that just need to name a namespace. */
export async function resolveWorkspaceKey(workspacePath: string): Promise<string> {
  return (await canonicalizeWorkspace(workspacePath)).key;
}

/** Absolute namespace directory for a canonical workspace key. */
export function companyNamespaceDir(workspaceKey: string): string {
  const hash = createHash('sha256').update(workspaceKey).digest('hex');
  return path.join(os.homedir(), LAYOUT_FILE_DIR, COMPANY_STATE_DIR, hash);
}

export class CompanyStore {
  /** Folded identity key (namespace identity). */
  readonly workspaceKey: string;
  /** Absolute namespace directory; artifacts and the journal live here. */
  readonly namespaceDir: string;
  /** Ids of recovery artifacts written during the most recent `load()`. */
  readonly recoveryArtifactIds: string[] = [];

  /** Canonical real path of the workspace this namespace belongs to. */
  readonly workspacePath: string;
  private readonly journalPath: string;
  private readonly statePath: string;
  private readonly artifactDir: string;
  private state: CompanyState;
  /**
   * The board's models, decided once before any run could start.
   *
   * A namespace with no snapshot yet opens with THESE models rather than the
   * fallback: `load()` builds that first state here and the coordinator adopts
   * whatever comes back, so a store that seeded itself would overwrite the
   * models the host answered with on a fresh workspace. Undefined means no host
   * answered, which is the documented fallback.
   */
  private readonly modelRoles?: CompanyModelResolution;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    workspaceKey: string,
    workspacePath: string,
    namespaceDir: string,
    initial: CompanyState,
    modelRoles?: CompanyModelResolution,
  ) {
    this.workspaceKey = workspaceKey;
    this.workspacePath = workspacePath;
    this.namespaceDir = namespaceDir;
    this.journalPath = path.join(namespaceDir, COMPANY_JOURNAL_FILE);
    this.statePath = path.join(namespaceDir, COMPANY_STATE_FILE);
    this.artifactDir = path.join(namespaceDir, COMPANY_ARTIFACT_DIR);
    this.state = initial;
    this.modelRoles = modelRoles;
  }

  /**
   * Open (creating the namespace if needed) without reading. Reading is a
   * separate `load()` because a follower holds a handle and polls for the
   * owner's revisions rather than owning the write path.
   *
   * `modelRoles` is the host read the caller already performed for this start;
   * it is stored rather than re-read so a namespace can never seed a board from
   * a second, different answer.
   */
  static async open(
    workspacePath: string,
    modelRoles?: CompanyModelResolution,
  ): Promise<CompanyStore> {
    const { realPath, key } = await canonicalizeWorkspace(workspacePath);
    const namespaceDir = companyNamespaceDir(key);
    await fs.promises.mkdir(path.join(namespaceDir, COMPANY_ARTIFACT_DIR), { recursive: true });
    return new CompanyStore(
      key,
      realPath,
      namespaceDir,
      createInitialCompanyState(realPath, modelRoles),
      modelRoles,
    );
  }

  /**
   * Committed state, replayed from snapshot + journal. Idempotent.
   *
   * Chained through the same queue as `commit()`: a read that started between
   * a commit's revision check and its snapshot write would otherwise reassign
   * `state` mid-write and could regress the snapshot.
   */
  async load(): Promise<CompanyState> {
    const run = this.writeQueue.then(() => this.loadLocked());
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async loadLocked(): Promise<CompanyState> {
    this.recoveryArtifactIds.length = 0;
    this.state = await this.readSnapshot();
    const journal = await this.readJournal();

    if (journal.tornTail) {
      // Preserve the interrupted bytes BEFORE truncating, so a forensic copy
      // survives even if the truncation itself fails.
      const artifactId = await this.writeArtifact(journal.tornTail, 'application/octet-stream');
      this.recoveryArtifactIds.push(artifactId);
      await this.truncateJournalToLastCompleteLine();
    }

    for (const event of journal.events) {
      if (event.sequence <= this.state.revision) continue; // already in the snapshot
      this.state = applyCompanyEvent(this.state, event);
    }
    return this.state;
  }

  /**
   * Commit one event. The journal append is the commit point; the snapshot is a
   * cache rebuilt from it. Rejects a stale base revision rather than merging.
   */
  async commit(event: CompanyEvent): Promise<void> {
    const run = this.writeQueue.then(() => this.commitLocked(event));
    // Keep the queue alive even when this commit rejects.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** Store bytes and return their artifact id. Fsynced before it returns. */
  async writeArtifact(content: Uint8Array, contentType: string): Promise<string> {
    const id = randomUUID();
    await fs.promises.mkdir(this.artifactDir, { recursive: true });

    await writeFileSynced(
      path.join(this.artifactDir, `${id}${COMPANY_ARTIFACT_BODY_SUFFIX}`),
      content,
    );
    await writeFileSynced(
      path.join(this.artifactDir, `${id}${COMPANY_ARTIFACT_META_SUFFIX}`),
      Buffer.from(JSON.stringify({ contentType, byteLength: content.byteLength }), 'utf-8'),
    );
    return id;
  }

  /** Read up to `limit` raw bytes of an artifact starting at `offset`. */
  async readArtifact(id: string, offset: number, limit: number): Promise<ArtifactPage> {
    if (!COMPANY_ARTIFACT_ID_PATTERN.test(id)) {
      throw new CompanyError('invalid_artifact_id', `Not an artifact id: ${id}`);
    }
    const bodyPath = path.join(this.artifactDir, `${id}${COMPANY_ARTIFACT_BODY_SUFFIX}`);
    const metaPath = path.join(this.artifactDir, `${id}${COMPANY_ARTIFACT_META_SUFFIX}`);

    let contentType: string;
    let totalBytes: number;
    try {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')) as {
        contentType?: unknown;
        byteLength?: unknown;
      };
      contentType = typeof meta.contentType === 'string' ? meta.contentType : DEFAULT_CONTENT_TYPE;
      totalBytes = typeof meta.byteLength === 'number' ? meta.byteLength : 0;
    } catch {
      // Metadata missing or unreadable: fall back to the body file itself.
      try {
        totalBytes = (await fs.promises.stat(bodyPath)).size;
      } catch {
        throw new CompanyError('artifact_not_found', `Unknown artifact: ${id}`);
      }
      contentType = DEFAULT_CONTENT_TYPE;
    }

    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const pageSize = Math.min(
      Math.max(1, Math.floor(limit) || COMPANY_ARTIFACT_PAGE_BYTES),
      COMPANY_ARTIFACT_PAGE_BYTES,
    );
    const handle = await fs.promises.open(bodyPath, 'r');
    try {
      const buffer = Buffer.alloc(pageSize);
      const { bytesRead } = await handle.read(buffer, 0, pageSize, safeOffset);
      return {
        id,
        offset: safeOffset,
        totalBytes,
        dataBase64: buffer.subarray(0, bytesRead).toString('base64'),
        contentType,
        eof: safeOffset + bytesRead >= totalBytes,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * True when the artifact's body is already on disk.
   *
   * A change that cites a diff artifact must cite one that was written, not one
   * a Worker invented, so the delivery path checks existence before it commits
   * anything rather than discovering a dangling reference later.
   */
  async hasArtifact(id: string): Promise<boolean> {
    if (!COMPANY_ARTIFACT_ID_PATTERN.test(id)) return false;
    try {
      await fs.promises.access(path.join(this.artifactDir, `${id}${COMPANY_ARTIFACT_BODY_SUFFIX}`));
      return true;
    } catch {
      return false;
    }
  }

  private async commitLocked(event: CompanyEvent): Promise<void> {
    if (event.baseRevision !== this.state.revision) {
      throw new CompanyError(
        'company_revision_conflict',
        `Cannot commit at base ${event.baseRevision}; store is at ${this.state.revision}.`,
      );
    }
    const next = applyCompanyEvent(this.state, event);
    await fs.promises.mkdir(this.namespaceDir, { recursive: true });
    await appendAndSync(this.journalPath, `${JSON.stringify(event)}\n`);
    this.state = next;
    await this.writeSnapshot();
  }

  private async readSnapshot(): Promise<CompanyState> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.statePath, 'utf-8');
    } catch {
      return createInitialCompanyState(this.workspacePath, this.modelRoles);
    }
    try {
      const parsed = JSON.parse(raw) as CompanyState;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.revision !== 'number') {
        throw new Error('snapshot has no revision');
      }
      return parsed;
    } catch (err) {
      // The snapshot is only a cache and the journal is the authority, so an
      // unreadable cache rebuilds from the journal instead of failing to open.
      console.warn('[Pixel Agents] Company snapshot unreadable; replaying journal:', err);
      return createInitialCompanyState(this.workspacePath);
    }
  }

  private async readJournal(): Promise<JournalReadResult> {
    let raw: Buffer;
    try {
      raw = await fs.promises.readFile(this.journalPath);
    } catch {
      return { events: [] };
    }
    if (raw.length === 0) return { events: [] };

    // Everything through the last newline is a complete record; the remainder
    // is an interrupted append.
    const lastNewline = raw.lastIndexOf(NEWLINE_BYTE);
    const complete = raw.subarray(0, lastNewline + 1).toString('utf-8');
    const tail = raw.subarray(lastNewline + 1);

    const events: CompanyEvent[] = [];
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as CompanyEvent);
      } catch (err) {
        throw new CompanyError('company_store_corrupt', 'Journal contains a malformed record.', {
          cause: err,
        });
      }
    }
    return tail.length > 0 ? { events, tornTail: tail } : { events };
  }

  private async truncateJournalToLastCompleteLine(): Promise<void> {
    const raw = await fs.promises.readFile(this.journalPath);
    const handle = await fs.promises.open(this.journalPath, 'r+');
    try {
      await handle.truncate(raw.lastIndexOf(NEWLINE_BYTE) + 1);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeSnapshot(): Promise<void> {
    const tmpPath = `${this.statePath}.tmp`;
    await writeFileSynced(tmpPath, Buffer.from(JSON.stringify(this.state, null, 2), 'utf-8'), 'w');
    await fs.promises.rename(tmpPath, this.statePath);
  }
}

const NEWLINE_BYTE = 0x0a;
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

async function writeFileSynced(
  filePath: string,
  data: Uint8Array,
  flags: 'wx' | 'w' = 'wx',
): Promise<void> {
  const handle = await fs.promises.open(filePath, flags);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function appendAndSync(filePath: string, data: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'a');
  try {
    await handle.writeFile(data, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
