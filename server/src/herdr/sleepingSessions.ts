import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { jsonField } from './jsonField.js';
import { isHerdrPaneId } from './paneId.js';

/** Bytes of a session file read for its title; the title line is the file's first line. */
const TITLE_HEAD_BYTES = 64 * 1024;
/** Titles keep at most this many characters, as the sanitizer in omp-ngu.ts does. */
const TITLE_MAX_CHARS = 80;
const TITLE_MIN_CHARS = 3;
/** Keeps letters, digits, spaces, and the punctuation omp-ngu.ts allows in a title. */
const TITLE_DROP_PATTERN = /[^\p{L}\p{N} .,:;()\/_+-]/gu;
/** The pane label omp-ngu.ts gives a sleeping session: `zz omp[: <viec>] #<sid8>`. */
const SLEEP_LABEL_PATTERN = /^zz omp(?:: (.+?))? #([0-9a-f]{8})$/i;
/** omp session files end with the session uuid. */
const SESSION_ID_PATTERN = /_([0-9a-f-]{36})\.jsonl$/i;
const SID8_LENGTH = 8;
/** A session asleep with its pane closed is offered for this long; older ones are no longer listed. */
const CLOSED_SLEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SleepPhase = 'exit-requested' | 'sleeping';
export type SleepAgent = 'omp' | 'claude' | 'agy';

/** One entry of omp-ngu.json, as the sleep script writes it. */
export interface SleepRecord {
  readonly pane: string;
  readonly terminal: string;
  readonly file: string;
  readonly cwd: string;
  readonly phase: SleepPhase;
  /** When the session's exit was requested. The sleep itself follows a moment later. */
  readonly requestedAt: string;
  /** The agent the session belongs to; records written before agents other than omp slept have none. */
  readonly agent: SleepAgent;
  /** An empty Claude session (no message yet): waking opens a new `claude`, not a resume. */
  readonly fresh: boolean;
  /**
   * The sleep closed the pane (omp-ngu.ts from 2026-10-25): the board holds the session alone and
   * wakes it in a new tab. A record without this kept its pane open with the wake prompt.
   */
  readonly closed: boolean;
  /** The session's task, as the pane label carried it. */
  readonly title?: string;
  /** The herdr workspace the pane was in, where a closed session reopens. */
  readonly workspace?: string;
}

/** A herdr pane as `pane.list` describes it, reduced to the fields the judge reads. */
export interface PaneFact {
  readonly paneId: string;
  readonly workspaceId?: string;
  readonly terminalId?: string;
  readonly cwd?: string;
  readonly label?: string;
  /** Set when the pane runs an agent, such as omp. A shell pane has none. */
  readonly agent?: string;
  /** The session file an agent in this pane has open. */
  readonly sessionFile?: string;
}

/**
 * Why a registry record no longer names a sleeping session. Each reason is a fact that rules
 * out waking the record: a stale entry, a pane that moved on, or a session open elsewhere.
 */
export type SleepDropReason =
  | 'exit-requested'
  | 'superseded'
  | 'pane-closed'
  | 'awake'
  | 'pane-changed'
  | 'open-elsewhere'
  | 'expired';

/** What waking a session whose pane the sleep closed needs: a new tab here, running this resume. */
export interface ClosedSleepWake {
  readonly agent: SleepAgent;
  readonly file: string;
  readonly fresh: boolean;
  readonly cwd: string;
  readonly workspaceId?: string;
}

/** A record judged against the live panes, before its title is resolved. */
export type SleepCandidate =
  | {
      readonly status: 'sleeping';
      readonly paneId: string;
      readonly sessionFile: string;
      readonly sleptAt: string;
      readonly cwd?: string;
      readonly workspaceId?: string;
      /** The `-Viec` text that the pane label carries, when the label names this session. */
      readonly labelTitle?: string;
      /** Set when the pane is closed: the session wakes in a new tab. */
      readonly closed?: ClosedSleepWake;
    }
  | {
      readonly status: 'dropped';
      readonly paneId: string;
      readonly sessionFile: string;
      readonly reason: SleepDropReason;
    };

/** A session that is asleep and can be woken. */
export interface SleepingSession {
  readonly paneId: string;
  readonly title: string;
  readonly sessionFile: string;
  readonly sleptAt: string;
  readonly cwd?: string;
  readonly workspaceId?: string;
}

export type SleepJudgement =
  | {
      readonly status: 'sleeping';
      readonly paneId: string;
      readonly session: SleepingSession;
      readonly closed?: ClosedSleepWake;
    }
  | {
      readonly status: 'dropped';
      readonly paneId: string;
      readonly sessionFile: string;
      readonly reason: SleepDropReason;
    };

/** Reads omp-ngu.json. Unusable entries are skipped and reported in `problem`. */
export function parseSleepRegistry(text: string): {
  readonly records: SleepRecord[];
  readonly problem?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], problem: 'Sleep registry is not valid JSON; treating it as empty.' };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], problem: 'Sleep registry is not a JSON array; treating it as empty.' };
  }
  const records: SleepRecord[] = [];
  let skipped = 0;
  for (const entry of parsed as unknown[]) {
    const record = toSleepRecord(entry);
    if (record === undefined) skipped += 1;
    else records.push(record);
  }
  if (skipped === 0) return { records };
  return { records, problem: `Sleep registry: skipped ${skipped} unusable entries.` };
}

function toSleepRecord(entry: unknown): SleepRecord | undefined {
  const pane = jsonField(entry, 'pane');
  const terminal = jsonField(entry, 'terminal');
  const file = jsonField(entry, 'file');
  const cwd = jsonField(entry, 'cwd');
  const phase = jsonField(entry, 'phase');
  const ts = jsonField(entry, 'ts');
  if (!isHerdrPaneId(pane) || typeof terminal !== 'string') return undefined;
  if (typeof file !== 'string' || file === '' || typeof cwd !== 'string') return undefined;
  if (phase !== 'sleeping' && phase !== 'exit-requested') return undefined;
  if (typeof ts !== 'string') return undefined;
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return undefined;
  const agent = jsonField(entry, 'agent');
  const title = jsonField(entry, 'title');
  const workspace = jsonField(entry, 'workspace');
  return {
    pane,
    terminal,
    file,
    cwd,
    phase,
    requestedAt: new Date(at).toISOString(),
    agent: agent === 'claude' || agent === 'agy' ? agent : 'omp',
    fresh: jsonField(entry, 'fresh') === true,
    closed: jsonField(entry, 'closed') === true,
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
    ...(typeof workspace === 'string' && workspace !== '' ? { workspace } : {}),
  };
}

/**
 * Judges every record against the live panes. A record stands only when it is the last one
 * for its pane and for its session, its phase is `sleeping`, and no other pane has the session
 * open. A record that kept its pane also needs that pane to exist, run no agent and still name
 * this session; one whose pane the sleep closed needs to be younger than CLOSED_SLEEP_MAX_AGE_MS.
 */
export function judgeSleepRecords(
  records: readonly SleepRecord[],
  panes: readonly PaneFact[],
  now = Date.now(),
): SleepCandidate[] {
  const latest: LatestRecords = { byPane: new Map(), byFile: new Map() };
  records.forEach((record, index) => {
    // herdr hands a closed pane's id to a later pane, so a closed record claims no pane id.
    if (!record.closed) latest.byPane.set(record.pane, index);
    latest.byFile.set(sessionKey(record.file), index);
  });
  return records.map((record, index) => judgeRecord(record, index, latest, panes, now));
}

interface LatestRecords {
  readonly byPane: Map<string, number>;
  readonly byFile: Map<string, number>;
}

function judgeRecord(
  record: SleepRecord,
  index: number,
  latest: LatestRecords,
  panes: readonly PaneFact[],
  now: number,
): SleepCandidate {
  const key = sessionKey(record.file);
  const dropped = (reason: SleepDropReason): SleepCandidate => ({
    status: 'dropped',
    paneId: record.pane,
    sessionFile: record.file,
    reason,
  });
  if (record.closed) return judgeClosedRecord(record, index, latest, panes, now);
  if (latest.byPane.get(record.pane) !== index || latest.byFile.get(key) !== index) {
    return dropped('superseded');
  }
  if (record.phase !== 'sleeping') return dropped('exit-requested');
  const pane = panes.find((candidate) => candidate.paneId === record.pane);
  if (pane === undefined) return dropped('pane-closed');
  if (pane.agent !== undefined) return dropped('awake');

  // The label is the sleep script's own tag and carries the session id. A pane without that
  // label (renamed by hand) still stands when it is the terminal the sleep recorded.
  const labelMatch = SLEEP_LABEL_PATTERN.exec(pane.label ?? '');
  if (labelMatch !== null) {
    if (labelMatch[2]?.toLowerCase() !== key.slice(-SID8_LENGTH)) return dropped('pane-changed');
  } else if (pane.terminalId === undefined || pane.terminalId !== record.terminal) {
    return dropped('pane-changed');
  }

  const openElsewhere = panes.some(
    (other) =>
      other.paneId !== record.pane &&
      other.sessionFile !== undefined &&
      sessionKey(other.sessionFile) === key,
  );
  if (openElsewhere) return dropped('open-elsewhere');

  const cwd = record.cwd !== '' ? record.cwd : pane.cwd;
  const labelTitle = labelMatch?.[1];
  return {
    status: 'sleeping',
    paneId: record.pane,
    sessionFile: record.file,
    sleptAt: record.requestedAt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(pane.workspaceId !== undefined ? { workspaceId: pane.workspaceId } : {}),
    ...(labelTitle !== undefined ? { labelTitle } : {}),
  };
}

/**
 * A session whose pane the sleep closed: no pane to check, so it stands while it is the latest
 * record for its session, slept for good, is not older than CLOSED_SLEEP_MAX_AGE_MS, and no pane
 * has it open (one does once it is woken, by the board or by hand). Its id is `zz:<session id>`,
 * not the old pane id, which herdr may already have handed to another pane.
 */
function judgeClosedRecord(
  record: SleepRecord,
  index: number,
  latest: LatestRecords,
  panes: readonly PaneFact[],
  now: number,
): SleepCandidate {
  const key = sessionKey(record.file);
  const paneId = closedSleepId(key);
  const dropped = (reason: SleepDropReason): SleepCandidate => ({
    status: 'dropped',
    paneId,
    sessionFile: record.file,
    reason,
  });
  if (latest.byFile.get(key) !== index) return dropped('superseded');
  if (record.phase !== 'sleeping') return dropped('exit-requested');
  if (now - Date.parse(record.requestedAt) > CLOSED_SLEEP_MAX_AGE_MS) return dropped('expired');
  const open = panes.some(
    (pane) => pane.sessionFile !== undefined && sessionKey(pane.sessionFile) === key,
  );
  if (open) return dropped('awake');
  return {
    status: 'sleeping',
    paneId,
    sessionFile: record.file,
    sleptAt: record.requestedAt,
    cwd: record.cwd,
    ...(record.workspace !== undefined ? { workspaceId: record.workspace } : {}),
    ...(record.title !== undefined ? { labelTitle: record.title } : {}),
    closed: {
      agent: record.agent,
      file: record.file,
      fresh: record.fresh,
      cwd: record.cwd,
      ...(record.workspace !== undefined ? { workspaceId: record.workspace } : {}),
    },
  };
}

/**
 * The board's id for a closed-pane sleep: pane-id shaped, so clients and wake requests take it as
 * one. A hash of the whole session key, so two sessions whose ids end alike never share it.
 */
export function closedSleepId(sessionKeyValue: string): string {
  return `zz:${createHash('sha256').update(sessionKeyValue).digest('hex').slice(0, 16)}`;
}

/** The session id that identifies a session file across panes; the path stands in when no uuid is found. */
function sessionKey(file: string): string {
  const match = SESSION_ID_PATTERN.exec(file);
  return match?.[1]?.toLowerCase() ?? file;
}

/**
 * Reads omp-ngu.json, judges it against live panes, and titles the sessions that stand.
 * A missing registry means nothing sleeps; an unreadable one is reported once and read as empty.
 */
export class SleepRegistry {
  private readonly file: string;
  private readonly warn: (message: string) => void;
  private lastProblem: string | undefined;
  /** Title per session file, read from the file's head. Rebuilt on every judge, so stale files drop out. */
  private titles = new Map<string, string>();

  constructor(options: { readonly file: string; readonly warn: (message: string) => void }) {
    this.file = options.file;
    this.warn = options.warn;
  }

  /** Judges every registry record against the live panes. Never rejects. */
  async judge(panes: readonly PaneFact[]): Promise<SleepJudgement[]> {
    const candidates = judgeSleepRecords(await this.readRecords(), panes);
    const titles = new Map<string, string>();
    const judgements: SleepJudgement[] = [];
    for (const candidate of candidates) {
      if (candidate.status === 'dropped') {
        judgements.push(candidate);
        continue;
      }
      const fileTitle =
        this.titles.get(candidate.sessionFile) ?? (await readSessionTitle(candidate.sessionFile));
      titles.set(candidate.sessionFile, fileTitle);
      const title =
        candidate.labelTitle ??
        (fileTitle !== '' ? fileTitle : path.basename(candidate.sessionFile, '.jsonl'));
      const session: SleepingSession = {
        paneId: candidate.paneId,
        title,
        sessionFile: candidate.sessionFile,
        sleptAt: candidate.sleptAt,
        ...(candidate.cwd !== undefined ? { cwd: candidate.cwd } : {}),
        ...(candidate.workspaceId !== undefined ? { workspaceId: candidate.workspaceId } : {}),
      };
      judgements.push({
        status: 'sleeping',
        paneId: candidate.paneId,
        session,
        ...(candidate.closed !== undefined ? { closed: candidate.closed } : {}),
      });
    }
    this.titles = titles;
    return judgements;
  }

  /** The sleeping sessions only, most recently slept first. */
  async sleepingSessions(panes: readonly PaneFact[]): Promise<SleepingSession[]> {
    const sessions: SleepingSession[] = [];
    for (const judgement of await this.judge(panes)) {
      if (judgement.status === 'sleeping') sessions.push(judgement.session);
    }
    return sessions.sort(
      (a, b) => b.sleptAt.localeCompare(a.sleptAt) || a.paneId.localeCompare(b.paneId),
    );
  }

  /**
   * Drops the closed-pane records of a session once the board has reopened it. Waking cannot
   * rely on the new pane naming the same session: an empty Claude session (no transcript) comes
   * back under a new id, and its old record would otherwise stay "asleep" for seven days. Every
   * other entry is written back as read, unknown fields included. Never rejects.
   */
  async forgetClosed(file: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const kept = (parsed as unknown[]).filter(
        (entry) => !(jsonField(entry, 'closed') === true && jsonField(entry, 'file') === file),
      );
      if (kept.length === parsed.length) return;
      await fs.writeFile(this.file, `${JSON.stringify(kept, null, 2)}\n`);
    } catch (error) {
      this.warn(`Cannot drop the woken session from ${this.file}: ${String(error)}`);
    }
  }

  private async readRecords(): Promise<SleepRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      // A missing registry is the normal state when nothing sleeps.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.note(undefined);
        return [];
      }
      this.note(`Cannot read sleep registry ${this.file}; treating it as empty.`);
      return [];
    }
    const parsed = parseSleepRegistry(text);
    this.note(parsed.problem);
    return parsed.records;
  }

  /** Warns once per distinct problem, and forgets it once the registry reads clean again. */
  private note(problem: string | undefined): void {
    if (problem === undefined) {
      this.lastProblem = undefined;
      return;
    }
    if (problem === this.lastProblem) return;
    this.lastProblem = problem;
    this.warn(problem);
  }
}

/**
 * Title of a session from the top of its file: the title line, else the first user prompt.
 * Empty when neither is usable. A failed read is also empty; the caller falls back to the file name.
 */
async function readSessionTitle(file: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(TITLE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TITLE_HEAD_BYTES, 0);
    return sessionTitleFromHead(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Title line first; the first user prompt when the file has no usable title. Lines that fail to parse are skipped. */
export function sessionTitleFromHead(head: string): string {
  let prompt = '';
  for (const line of head.split('\n')) {
    const entry = parseJsonLine(line);
    const type = jsonField(entry, 'type');
    if (type === 'title') {
      const raw = jsonField(entry, 'title');
      const title = typeof raw === 'string' ? sanitizeTitle(raw) : '';
      if (title !== '') return title;
    } else if (prompt === '' && type === 'message') {
      prompt = sanitizeTitle(firstUserText(jsonField(entry, 'message')));
    }
  }
  return prompt;
}

function parseJsonLine(line: string): unknown {
  if (line === '') return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    // The head read can end mid-line, so a line that fails to parse is simply not usable.
    return undefined;
  }
}

function firstUserText(message: unknown): string {
  if (jsonField(message, 'role') !== 'user') return '';
  const content = jsonField(message, 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content as unknown[]) {
    if (jsonField(block, 'type') !== 'text') continue;
    const text = jsonField(block, 'text');
    if (typeof text === 'string') return text;
  }
  return '';
}

function sanitizeTitle(text: string): string {
  const kept = text.replace(/\s+/g, ' ').replace(TITLE_DROP_PATTERN, '').trim();
  const title = [...kept].slice(0, TITLE_MAX_CHARS).join('').trim();
  return title.length < TITLE_MIN_CHARS ? '' : title;
}
