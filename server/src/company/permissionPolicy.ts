/**
 * permissionPolicy: what a company role may do, and when it must ask.
 *
 * The host is not an OS sandbox and never claims to be. This gate protects the
 * calls an agent makes, which is where a mistake actually does damage, and it
 * fails closed on three axes:
 *
 *  - Role: Director, Advisor and Judge have no effectful tools at all — not
 *    "ask first", never. QA gets exactly one extra tool, the verification
 *    runner, because running the Contract's own commands is its job.
 *  - Scope: a Worker may write only inside a scope the approved Contract
 *    declares. Writing outside one needs a new Contract revision, and
 *    approve-once never buys it.
 *  - Content: deletes, lockfiles, secrets, databases, migrations and arbitrary
 *    shell always ask, even inside an approved scope. Scope says WHERE, not
 *    WHAT.
 *
 * An approval is bound to the exact payload (session, task, epoch, tool call and
 * the full argument object). Change one character of that payload and the
 * digest changes, so a stale "approve once" can never be replayed onto a
 * different edit.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompanyRole, WriteScope } from '../../../core/src/company.js';

/** A verification command the Contract approved to run unattended. */
export interface ApprovedVerificationCommand {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
}

export interface ToolCallRequest {
  role: CompanyRole;
  tool: string;
  args: Record<string, unknown>;
  /** Canonical workspace root; nothing outside it is ever writable. */
  workspaceRoot: string;
  writeScopes: WriteScope[];
  approvedCommands?: ApprovedVerificationCommand[];
  /** Present only when the user already answered this exact action. */
  approval?: 'approve_once' | 'reject';
}

export type PermissionDecision =
  | { allowed: true; reason: string }
  | { allowed: false; requiresApproval: false; reason: string }
  | { allowed: false; requiresApproval: true; reason: string };

export interface ApprovalBinding {
  sessionId: string;
  taskId: string;
  runEpoch: number;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
}

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'list_dir', 'search']);
const ASK_TOOLS = new Set(['ask', 'todo', 'wait', 'sleep']);
const WORKER_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit']);
const WORKER_ASK_TOOLS = new Set(['task', 'bash', 'eval', 'exec']);
const COMPANY_VERIFY_TOOL = 'company_verify';

/** Roles that may never reach an effectful tool, for any approval answer. */
const READ_ONLY_ROLES: ReadonlySet<CompanyRole> = new Set(['director', 'advisor', 'judge']);

/** Paths that need a human even when a scope covers them. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i,
  // `secret.env` and `prod.env.local` are as sensitive as `.env`, so the whole
  // basename family matches, not just dotfiles.
  /(^|\/)([^/]*\.)?env(\.[^/]*)?$/i,
  /(^|\/)(secrets?|credentials?|\.npmrc|\.netrc|id_rsa(\.pub)?)$/i,
  /\.(sqlite3?|db|pem|key)$/i,
  /(^|\/)(migrations?|migrate)\//i,
  /(^|\/)\.git\//i,
  /(^|\/)node_modules\//i,
];
/** Shell operators that turn a "command" into an unreviewable script. */
const SHELL_OPERATORS = /[|;&<>`]|\$\(|\$\{|\n/;

function allow(reason: string): PermissionDecision {
  return { allowed: true, reason };
}

function deny(reason: string): PermissionDecision {
  return { allowed: false, requiresApproval: false, reason };
}

function ask(reason: string): PermissionDecision {
  return { allowed: false, requiresApproval: true, reason };
}

function isCompanyTool(tool: string): boolean {
  return tool.startsWith('company_');
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeRelative(target: string): string {
  return target.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Canonical path of a workspace-relative target, tolerating a file that does
 * not exist yet by canonicalizing the nearest existing ancestor. Rejects
 * anything whose real path leaves the workspace, including through a symlink
 * or a Windows junction.
 */
export function resolveWorkspaceTarget(workspaceRoot: string, relativePath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  let existing = target;
  while (existing !== root && !fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realRoot: string;
  let realExisting: string;
  try {
    realRoot = fs.realpathSync(root);
    realExisting = fs.realpathSync(existing);
  } catch {
    return null;
  }
  const realRelative = path.relative(realRoot, realExisting);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
  return path.join(realRoot, relative);
}

function isInsideApprovedScope(relativePath: string, scopes: WriteScope[]): boolean {
  const target = normalizeRelative(relativePath);
  return scopes.some((scope) => {
    const scoped = normalizeRelative(scope.path);
    if (scoped === '' || scoped === '.') return true; // whole workspace
    return target === scoped || target.startsWith(`${scoped}/`);
  });
}

function isSensitive(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function matchesApprovedCommand(
  args: Record<string, unknown>,
  approved: ApprovedVerificationCommand | undefined,
): boolean {
  if (!approved) return false;
  const executable = stringArg(args, 'executable');
  const cwd = stringArg(args, 'cwd');
  const argv = args['argv'];
  if (!executable || !cwd || !Array.isArray(argv)) return false;
  if (path.resolve(cwd) !== path.resolve(approved.cwd)) return false;
  if (executable !== approved.executable) return false;
  if (argv.length !== approved.argv.length) return false;
  return argv.every((value, index) => value === approved.argv[index]);
}

/**
 * Decide one tool call. Pure with respect to the filesystem: it reads paths to
 * canonicalize them, but performs no write and starts no process.
 */
export function decideToolCall(request: ToolCallRequest): PermissionDecision {
  const { role, tool, args } = request;

  if (READ_TOOLS.has(tool) || ASK_TOOLS.has(tool)) {
    return allow(`${tool} is a read/no-side-effect tool.`);
  }

  // QA's one extra capability: run the Contract's own verification commands.
  if (tool === COMPANY_VERIFY_TOOL) {
    if (role !== 'qa') return deny(`Only QA may run verification commands.`);
    const commandId = stringArg(args, 'id');
    const approved = request.approvedCommands?.find((entry) => entry.id === commandId);
    if (!approved) return ask('Lệnh kiểm chứng không nằm trong hợp đồng đã duyệt.');
    if (!matchesApprovedCommand(args, approved)) {
      return ask('Tham số của lệnh kiểm chứng khác với hợp đồng đã duyệt.');
    }
    return allow('Exact approved verification command.');
  }

  if (isCompanyTool(tool)) {
    return READ_ONLY_ROLES.has(role)
      ? allow('Company metadata tool.')
      : allow('Company metadata tool.');
  }

  if (READ_ONLY_ROLES.has(role)) {
    return deny(`${role} has no effectful tools; this is not approvable.`);
  }

  if (role === 'qa') {
    // QA runs verification and reads; everything else needs a different role.
    return deny('QA may read and run verification only; this is not approvable.');
  }

  if (WORKER_WRITE_TOOLS.has(tool)) {
    const target = stringArg(args, 'path');
    if (!target) return ask('Ghi tệp cần một đường dẫn tường minh.');
    if (resolveWorkspaceTarget(request.workspaceRoot, target) === null) {
      // Approve-once can expand scope inside the workspace, never leave it.
      return deny('Path resolves outside the canonical workspace.');
    }
    if (!isInsideApprovedScope(target, request.writeScopes)) {
      return ask('Đường dẫn nằm ngoài mọi phạm vi ghi đã duyệt; cần một bản Hợp đồng sửa đổi.');
    }
    if (isSensitive(target)) {
      return ask('Tệp khóa, bí mật, cơ sở dữ liệu và bản migration luôn cần người dùng.');
    }
    return allow('Write is inside an approved scope.');
  }

  if (tool === 'bash' || tool === 'exec' || tool === 'eval') {
    const command = stringArg(args, 'command');
    if (command !== null && SHELL_OPERATORS.test(command)) {
      return ask('Toán tử shell biến thành một chuỗi lệnh không thể xem xét.');
    }
    return ask('Shell tùy ý luôn cần người dùng; chỉ lệnh kiểm chứng đã duyệt mới chạy một mình.');
  }

  if (WORKER_ASK_TOOLS.has(tool)) {
    return ask(`${tool} cần người dùng trước khi chạy.`);
  }

  // Unknown or custom effectful tools fail closed.
  return deny(`Unknown tool "${tool}" fails closed.`);
}

/**
 * Stable digest of the exact action an approval authorizes. Any change to the
 * tool, its arguments, the task or the run epoch produces a different digest,
 * so an approval cannot be carried onto a different edit.
 */
export function actionDigest(binding: ApprovalBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        runEpoch: binding.runEpoch,
        toolCallId: binding.toolCallId,
        tool: binding.tool,
        args: binding.args,
      }),
    )
    .digest('hex');
}
