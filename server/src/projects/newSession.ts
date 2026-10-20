import * as path from 'node:path';

import type {
  ProjectSessionStartMessage,
  ProjectSessionStartResultMessage,
  ProjectSettingsValues,
  ProjectTreeNode,
} from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';
import { createProjectSessionWorktree } from './projectSessionWorktree.js';
import type { ProjectTreeSnapshot } from './projectTree.js';
import type { ProjectModuleDeps } from './services.js';

export interface ProjectSessionLaunch {
  readonly sessionId: string;
  readonly checkout?: string;
}

export interface ProjectSessionServices {
  readonly effectiveSettings: (nodeId: string) => Promise<ProjectSettingsValues>;
  readonly runGit: (
    file: string,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  readonly openChat: (input: { readonly folder: string; readonly cwd: string; readonly prompt: string }) => Promise<string>;
  readonly startClaudeRun: (input: { readonly folder: string; readonly cwd: string; readonly prompt: string; readonly inPlace: boolean }) => Promise<ProjectSessionLaunch>;
  readonly startAgyRun: (input: { readonly folder: string; readonly cwd: string; readonly prompt: string; readonly inPlace: boolean }) => Promise<ProjectSessionLaunch>;
  readonly runSetupScript: (
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ readonly code: number; readonly stderr: string }>;
}


/** Start a session from a Project checkout using a separate worktree or shared directory. */
export async function startProjectSession(
  request: ProjectSessionStartMessage,
  deps: ProjectModuleDeps<ProjectSessionServices>,
): Promise<ProjectSessionStartResultMessage> {
  if (request.taskName.trim() === '') throw new LibraryUserError('Hãy nhập tên việc.');
  if (!request.initialPrompt.trim()) throw new LibraryUserError('Hãy nhập prompt đầu tiên.');
  const tree = await deps.loadTree();
  const node = tree.nodes.find((candidate) => candidate.id === request.nodeId);
  if (node === undefined) throw new LibraryUserError('Không tìm thấy thư mục hoặc repo đã chọn.');
  const folder = findFolder(node, tree);
  const folderPath = folder.path;
  if (folderPath === undefined) throw new LibraryUserError('Không tìm thấy đường dẫn thư mục Project.');
  const repos = tree.nodes.filter((candidate) => candidate.kind === 'repository' && candidate.parentId === folder.id);
  const repo = node.kind === 'repository' ? node : ancestor(node, tree, 'repository');
  const selectedRepo = repo ?? (repos.length === 1 ? repos[0] : undefined);
  if (selectedRepo === undefined && repos.length > 1) {
    throw new LibraryUserError('Thư mục có nhiều repo. Hãy chọn repo cần mở phiên.');
  }
  // A folder that is not a git repo still hosts a plain omp chat, run right in the folder.
  if (selectedRepo === undefined) {
    if (request.engine !== 'omp') throw new LibraryUserError('Thư mục này không phải repo git: Claude và agy cần repo. Hãy chọn OMP.');
    if (request.worktree !== 'shared') throw new LibraryUserError('Thư mục này không phải repo git nên không tạo được worktree. Hãy chọn "Dùng chung thư mục này".');
  }
  const repoPath = selectedRepo === undefined ? folderPath : selectedRepo.path;
  if (repoPath === undefined) throw new LibraryUserError('Đường dẫn repo không hợp lệ.');
  const sharedCheckout = node.kind === 'checkout' ? node.path : repoPath;
  const schedulerCreatesWorktree = request.engine !== 'omp' && request.worktree === 'separate';
  const checkout = schedulerCreatesWorktree
    ? repoPath
    : request.worktree === 'shared'
      ? sharedCheckout
      : (await createProjectSessionWorktree({
        repo: repoPath,
        taskName: request.taskName,
        run: deps.services.runGit,
      })).path;
  if (checkout === undefined) throw new LibraryUserError('Đường dẫn checkout không hợp lệ.');
  if (request.worktree === 'shared' && isProtectedMainRepo(checkout)) {
    throw new LibraryUserError('Không thể dùng chung thư mục chính của Project_QuanLyGiaiDau. Hãy tạo worktree riêng.');
  }
  if (request.worktree === 'separate' && request.engine === 'omp') {
    const settings = await deps.services.effectiveSettings(folder.id);
    const script = settings.worktreePrepare;
    if (script !== undefined) {
      const result = await deps.services.runSetupScript(script.argv, checkout, script.timeoutMs);
      if (result.code !== 0) {
        throw new LibraryUserError(`Script chuẩn bị worktree thất bại: ${result.stderr.trim() || `mã ${result.code}`}`);
      }
    }
  }

  let sessionId: string;
  let launchedCheckout: string | undefined;
  try {
    if (request.engine === 'omp') {
      sessionId = await deps.services.openChat({ folder: folderPath, cwd: checkout, prompt: request.initialPrompt });
      launchedCheckout = checkout;
    } else {
      const launch = await (request.engine === 'claude' ? deps.services.startClaudeRun : deps.services.startAgyRun)({
        folder: folderPath,
        cwd: checkout,
        prompt: request.initialPrompt,
        inPlace: request.worktree === 'shared',
      });
      sessionId = launch.sessionId;
      launchedCheckout = launch.checkout;
    }
  } catch (error) {
    throw new LibraryUserError(error instanceof Error ? error.message : 'Không mở được phiên mới.');
  }
  return {
    type: 'projectSessionStartResult',
    requestId: request.requestId,
    ok: true,
    sessionId,
    ...(launchedCheckout === undefined ? {} : { checkout: launchedCheckout }),
  };
}

function findFolder(node: ProjectTreeNode, tree: ProjectTreeSnapshot): ProjectTreeNode {
  if (node.kind === 'folder') {
    if (node.path === undefined) throw new LibraryUserError('Không tìm thấy đường dẫn thư mục Project.');
    return node;
  }
  const found = ancestor(node, tree, 'folder');
  if (found === undefined || found.path === undefined) throw new LibraryUserError('Không tìm thấy thư mục Project.');
  return found;
}

function ancestor(node: ProjectTreeNode, tree: ProjectTreeSnapshot, kind: ProjectTreeNode['kind']): ProjectTreeNode | undefined {
  let current = node;
  while (current.kind !== kind && current.parentId !== undefined) {
    const parent = tree.nodes.find((candidate) => candidate.id === current.parentId);
    if (parent === undefined) return undefined;
    current = parent;
  }
  return current.kind === kind ? current : undefined;
}

function isProtectedMainRepo(checkout: string): boolean {
  const normalized = path.resolve(checkout).replaceAll('\\', '/').toLocaleLowerCase('en-US');
  return /\/duancanhan\/project_quanlygiai[dđ]au\/[^/]+$/.test(normalized) &&
    !normalized.includes('/.worktrees/');
}

