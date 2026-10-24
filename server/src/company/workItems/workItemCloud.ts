import type {
  WorkItem,
  WorkItemCloud,
  WorkItemCloudIssue,
  WorkItemCloudState,
} from '../../../../core/src/messages.js';
import type { CommandResult } from './squadWorktree.js';

export interface FastHandoffIssue {
  readonly issue: number;
  readonly url: string;
}

export interface OrchestratorComment {
  readonly summary: string;
  readonly logUrl?: string;
}

const CLOUD_STATES: readonly WorkItemCloudState[] = [
  'running',
  'finished',
  'waiting_clean',
  'diverged',
  'pulled',
  'no_changes',
  'closed',
];

/** Validates an optional persisted cloud record; malformed metadata is dropped, not the work item. */
export function parseWorkItemCloud(value: unknown): WorkItemCloud | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { issue, url, branch, repo, state, startedAt } = record;
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1) return undefined;
  if (typeof url !== 'string' || url === '' || typeof branch !== 'string' || branch === '') return undefined;
  if (typeof repo !== 'string' || repo === '' || typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return undefined;
  if (!CLOUD_STATES.includes(state as WorkItemCloudState)) return undefined;
  if (record.summary !== undefined && typeof record.summary !== 'string') return undefined;
  if (record.logUrl !== undefined && typeof record.logUrl !== 'string') return undefined;
  if (record.reason !== undefined && typeof record.reason !== 'string') return undefined;
  return {
    issue,
    url,
    branch,
    repo,
    state: state as WorkItemCloudState,
    startedAt,
    ...(typeof record.summary === 'string' ? { summary: record.summary.slice(0, 300) } : {}),
    ...(typeof record.logUrl === 'string' ? { logUrl: record.logUrl } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason.slice(0, 300) } : {}),
  };
}

const ISSUE_URL = /(?:LINK ISSUE:\s*|DA KICH HOAT QUA GH CLI:\s*)(https:\/\/github\.com\/babydanh\/agent-orchestrator\/issues\/(\d+))/i;
const ORCHESTRATOR_MARKER = '**OMP Orchestrator:**';

/** Reads the Issue link printed by either successful fast-handoff path. */
export function parseFastHandoffResult(result: CommandResult): FastHandoffIssue {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    const refusal = output.split(/\r?\n/).find((line) => /DUNG HANDOFF/i.test(line));
    throw new Error(refusal?.trim() || result.stderr.trim() || result.stdout.trim() || `fast-handoff thoát với mã ${result.code}.`);
  }
  const match = ISSUE_URL.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error('fast-handoff thành công nhưng không tìm thấy URL Issue.');
  }
  return { issue: Number(match[2]), url: match[1] };
}

/** Reads the summary and optional Actions log from an OMP Orchestrator comment. */
export function parseOrchestratorComment(body: string): OrchestratorComment | undefined {
  const marker = body.indexOf(ORCHESTRATOR_MARKER);
  if (marker < 0) return undefined;
  const lines = body.slice(marker + ORCHESTRATOR_MARKER.length).split(/\r?\n/);
  const summary = lines.map((line) => line.trim()).find((line) => line !== '');
  if (summary === undefined) return undefined;
  const log = lines.map((line) => /^\s*Log:\s*(https?:\/\/\S+)\s*$/i.exec(line)).find(Boolean)?.[1];
  const clipped = [...summary].slice(0, 300).join('');
  return { summary: clipped, ...(log === undefined ? {} : { logUrl: log }) };
}

/** Distinguishes a valid comments array without a marker from malformed or failed API output. */
export function parseOrchestratorComments(output: string): OrchestratorComment | null | undefined {
  let comments: unknown;
  try {
    comments = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(comments)) return undefined;
  for (const comment of comments.flat(1)) {
    if (typeof comment !== 'object' || comment === null) continue;
    const body = (comment as Record<string, unknown>).body;
    if (typeof body !== 'string') continue;
    const parsed = parseOrchestratorComment(body);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

const WORK_ITEM_STATUS: Readonly<Record<WorkItem['status'], string>> = {
  queued: 'đang chờ',
  running: 'đang làm',
  needs_input: 'chờ người dùng',
  review: 'đang kiểm tra',
  done: 'đã xong',
  failed: 'đang lỗi',
};

function handoffSections(item: WorkItem): string {
  const verdictReason = item.judge?.verdict === 'fail' ? item.judge.reason : undefined;
  const nextStep = item.delivery?.nextStep ?? 'chưa có bước tiếp theo';
  const history = item.history.slice(-5).map((event) => {
    const outcome = (event.message ?? event.kind).replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
    return `| ${event.kind} | ${outcome} | ${event.at} |`;
  });
  return [
    '## Mục tiêu',
    item.text.trim(),
    `Xong khi: ${(item.acceptance ?? '').trim() || 'việc được hoàn tất theo nội dung yêu cầu.'}`,
    '',
    '## Trạng thái',
    `- Xong: ${WORK_ITEM_STATUS[item.status]}`,
    `- Đang dở: ${verdictReason || 'không có lý do giám khảo chưa đạt'}`,
    `- Tiếp theo: ${nextStep}`,
    '',
    '## Đã thử',
    '| Cách | Kết quả | Vì sao / bằng chứng |',
    '|---|---|---|',
    ...(history.length > 0 ? history : ['| chưa có sự kiện | chưa có | chưa có |']),
    '',
    '## Ràng buộc đang có',
    '- không đổi (đã so)',
    '',
    '## Ràng buộc thay đổi lần này',
    '- không đổi (đã so)',
    '',
    '## Câu hỏi còn mở',
    `- ${item.reason?.trim() || 'không'}`,
  ].join('\n');
}

function handoffMetadata(item: WorkItem, at: string): string {
  const updated = at.slice(0, 16).replace('T', ' ');
  const branch = item.worktree?.branch ?? 'không có';
  return `Cập nhật: ${updated} · bởi: omp · nhánh: ${branch} · OpenSpec: không có`;
}

/** Writes a fresh template or appends a timestamped update without discarding prior notes. */
export function updateCloudHandoff(existing: string | undefined, item: WorkItem, at: string): string {
  const sections = handoffSections(item);
  const metadata = handoffMetadata(item, at);
  if (existing === undefined) {
    return `# Handoff: ${item.text.trim().slice(0, 80)}\n${metadata}\n\n${sections}\n`;
  }
  const time = at.slice(0, 16).replace('T', ' ');
  return `${existing.trimEnd()}\n\n## Cập nhật ${time} từ Agent Board\n\n${metadata}\n\n${sections}\n`;
}

/** TodoPending carries the item's goal, acceptance, judge blocker, and delivery next step. */
export function cloudTodoPending(item: WorkItem): string {
  const verdictReason = item.judge?.verdict === 'fail' ? item.judge.reason : undefined;
  return [
    item.text.trim(),
    `Xong khi: ${(item.acceptance ?? '').trim() || 'việc được hoàn tất theo nội dung yêu cầu.'}`,
    verdictReason ? `Lý do giám khảo chưa đạt: ${verdictReason}` : '',
    item.delivery?.nextStep ? `Bước tiếp theo: ${item.delivery.nextStep}` : '',
  ].filter((line) => line !== '').join('\n');
}

/** Counts porcelain status rows; pulling may safely ignore only the tool's baseline file. */
export function countUncommittedFiles(status: string, ignoreQualityBaseline = false): number {
  return status.split(/\r?\n/).filter((line) => {
    if (line.trim() === '') return false;
    if (!ignoreQualityBaseline) return true;
    const path = (line.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1) ?? '').replaceAll('\\', '/');
    return path !== '.ripwire_quality_baseline';
  }).length;
}

/** Parses `gh issue list` output and omits issues already attached to a board work item. */
export function parseOpenCloudIssues(output: string, linkedIssues: ReadonlySet<number>): WorkItemCloudIssue[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((value): WorkItemCloudIssue[] => {
    if (typeof value !== 'object' || value === null) return [];
    const issue = value as Record<string, unknown>;
    if (typeof issue.number !== 'number' || !Number.isInteger(issue.number) || linkedIssues.has(issue.number)) return [];
    if (typeof issue.title !== 'string' || !issue.title.startsWith('[Handoff]')) return [];
    if (typeof issue.url !== 'string' || typeof issue.createdAt !== 'string') return [];
    const repoMatch = typeof issue.body === 'string'
      ? /^\s*[-*]\s*\**Repo mục tiêu\**\s*:\s*(.+?)\s*$/im.exec(issue.body)
      : undefined;
    return [{
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt,
      state: 'running',
      ...(repoMatch?.[1] === undefined ? {} : { repo: repoMatch[1] }),
    }];
  });
}

export function missingCloudBranch(output: string): boolean {
  return /couldn.t find remote ref|couldn.t find remote branch|not our ref/i.test(output);
}
