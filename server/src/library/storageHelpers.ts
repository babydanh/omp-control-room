import * as path from 'node:path';

import type { LibraryStorageResult,LibraryStorageSearchRequest } from '../../../core/src/messages.js';
import type { EventRow, SessionRow } from '../ledger/ledgerDb.js';

// Storage-specific bounds stay in this slice to avoid adding unrelated global constants.
export const LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LIBRARY_PROOF_MAX_FILES = 500;
export const LIBRARY_PROOF_PATH_CACHE_MAX = 1000;
/** These proof scan settings are local to the storage slice; the shared constants files are phase-one-owned. */
export const LIBRARY_PROOF_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.html': 'text/html', '.json': 'application/json', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const LIBRARY_PROOF_REPOSITORIES = [
  'HethongBackendApi_QuanlyGiaiDau',
  'HethongFrontEndWeb_QLgiaidau',
  'HethongFrontEndApp_QLgiaidau',
] as const;
export const LIBRARY_PROOF_MAX_DEPTH = 6;

export interface ArchivableWorkItem {
  id: string;
  text: string;
  status: string;
  updatedAt: string;
  repo?: string;
  assignee: { kind: string; paneId?: string; sessionId?: string; name?: string };
  restoredAt?: string;
}

export function workItemArchivedAt(item: ArchivableWorkItem): number | null {
  if (!['done', 'failed', 'dismissed'].includes(item.status)) return null;
  const endedAt = Date.parse(item.updatedAt);
  if (!Number.isFinite(endedAt)) return null;
  const restoredAt = item.restoredAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(item.restoredAt);
  return Number.isFinite(restoredAt) && restoredAt >= endedAt ? null : endedAt;
}

export function isArchivedWorkItem(item: ArchivableWorkItem, now = Date.now()): boolean {
  const endedAt = workItemArchivedAt(item);
  return endedAt !== null && endedAt < now - LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS;
}

export function filterArchivedWorkItems<T extends ArchivableWorkItem>(
  items: readonly T[],
  request: Pick<LibraryStorageSearchRequest, 'query' | 'repo'>,
  now = Date.now(),
): T[] {
  const query = request.query?.trim().toLocaleLowerCase() ?? '';
  const repo = request.repo?.trim().toLocaleLowerCase() ?? '';
  return items.filter((item) => {
    if (!isArchivedWorkItem(item, now)) return false;
    if (repo !== '' && !(item.repo ?? '').toLocaleLowerCase().includes(repo)) return false;
    if (query === '') return true;
    const assignee = [item.assignee.kind, item.assignee.paneId, item.assignee.sessionId, item.assignee.name]
      .filter(Boolean).join(' ');
    return [item.text, item.repo, assignee].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}

export function filterSessionRows(
  sessions: readonly SessionRow[],
  events: readonly EventRow[],
  request: Pick<LibraryStorageSearchRequest, 'query' | 'repo' | 'agentType' | 'from' | 'to'>,
  transcriptPaths: ReadonlyMap<string, string>,
): LibraryStorageResult[] {
  const query = request.query?.trim().toLocaleLowerCase() ?? '';
  const repoFilter = request.repo?.trim().toLocaleLowerCase() ?? '';
  const from = request.from ? Date.parse(`${request.from}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
  const to = request.to ? Date.parse(`${request.to}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  if ((request.from && !Number.isFinite(from)) || (request.to && !Number.isFinite(to))) return [];
  const edits = new Map<string, Set<string>>();
  const reposBySession = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.repo) {
      const repos = reposBySession.get(event.sessionId) ?? new Set<string>();
      repos.add(event.repo);
      reposBySession.set(event.sessionId, repos);
    }
    if (event.kind === 'edit' || event.kind === 'write') {
      const paths = edits.get(event.sessionId) ?? new Set<string>();
      paths.add(event.pathKey ?? event.path ?? event.repo ?? event.id.toString());
      edits.set(event.sessionId, paths);
    }
  }
  return sessions.flatMap((session) => {
    const kind = normalizeAgentKind(session.agentKind);
    const timestamp = session.startedAt ?? session.lastSeen ?? '';
    const time = Date.parse(timestamp);
    const repos = [...(reposBySession.get(session.sessionId) ?? [])];
    if (request.agentType && kind !== request.agentType) return [];
    if (!Number.isFinite(time) || time < from || time > to) return [];
    if (repoFilter && !repos.some((repo) => repo.toLocaleLowerCase().includes(repoFilter)) && !(session.cwd ?? '').toLocaleLowerCase().includes(repoFilter)) return [];
    if (query && ![session.cwd, session.agentName, session.sessionId, ...repos].some((value) => value?.toLocaleLowerCase().includes(query))) return [];
    return [{
      id: `session:${session.sessionId}`,
      kind: 'sessions',
      title: session.agentName ? `${kind} · ${session.agentName}` : kind,
      description: `${timestamp} — ${session.endedAt ?? session.lastSeen ?? ''}`,
      repo: repos[0],
      cwd: session.cwd ?? undefined,
      timestamp,
      editedFileCount: edits.get(session.sessionId)?.size ?? 0,
      transcriptPath: transcriptPaths.get(session.sessionId),
      status: session.state ?? undefined,
    }];
  });
}

function normalizeAgentKind(kind: string | null): 'main' | 'sub' | 'claude' | 'agy' {
  if (kind === 'claude' || kind === 'agy' || kind === 'sub') return kind;
  return 'main';
}

export function redactOpenVikingSecrets(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*)["']?[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[redacted]');
}

export function parseOpenVikingOutput(output: string): LibraryStorageResult[] {
  let parsed: unknown;
  try {
    const jsonStart = output.search(/[{\[]/);
    parsed = JSON.parse(jsonStart < 0 ? output : output.slice(jsonStart));
  } catch {
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10).map((line, index) => ({
      id: `ov:${index}:${redactOpenVikingSecrets(line.slice(0, 80))}`,
      kind: 'openViking',
      title: redactOpenVikingSecrets(line.slice(0, 120)),
      description: redactOpenVikingSecrets(line),
    }));
  }
  const payload = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : parsed;
  const rows = Array.isArray(payload) ? payload : isRecord(payload)
    ? (Array.isArray(payload.results) ? payload.results : Array.isArray(payload.items) ? payload.items : Array.isArray(payload.memories) ? payload.memories : Array.isArray(payload.resources) ? payload.resources : [])
    : [];
  return rows.slice(0, 10).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const uri = redactOpenVikingSecrets(text(entry.uri) ?? text(entry.id) ?? text(entry.path) ?? '');
    if (!uri) return [];
    const summary = redactOpenVikingSecrets(text(entry.summary) ?? text(entry.abstract) ?? text(entry.description) ?? text(entry.content) ?? '');
    const score = typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : undefined;
    return [{
      id: `ov:${index}:${uri}`,
      kind: 'openViking',
      title: uri,
      uri,
      description: summary,
      ...(score === undefined ? {} : { score }),
    }];
  });
}

export async function resolveProofPathFromMap(
  proofId: string,
  paths: ReadonlyMap<string, string>,
  roots: readonly string[],
  resolveRealPath: (candidate: string) => Promise<string>,
): Promise<string> {
  const candidate = paths.get(proofId);
  if (candidate === undefined || candidate.split(/[\\/]/).includes('..')) throw new Error('Invalid proof path');
  const canonicalCandidate = await resolveRealPath(candidate);
  for (const root of roots) {
    const canonicalRoot = await resolveRealPath(root).catch(() => null);
    if (canonicalRoot !== null && proofPathIsWithinRoot(canonicalCandidate, canonicalRoot)) return canonicalCandidate;
  }
  throw new Error('Invalid proof path');
}

export function proofPathIsWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
