import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { LibraryStorageResult, LibraryStorageSearchRequest } from '../../../core/src/messages.js';
import { openLedgerSource } from '../ledger/ledgerDb.js';
import { LibraryUserError } from './libraryError.js';
import {
  filterArchivedWorkItems,
  filterSessionRows,
  LIBRARY_PROOF_MAX_DEPTH,
  LIBRARY_PROOF_MAX_FILES,
  LIBRARY_PROOF_MEDIA_TYPE_BY_EXTENSION,
  LIBRARY_PROOF_PATH_CACHE_MAX,
  LIBRARY_PROOF_REPOSITORIES,
  parseOpenVikingOutput,
  proofPathIsWithinRoot,
  resolveProofPathFromMap,
} from './storageHelpers.js';
import { registeredWorkItemServices } from './workItemRegistry.js';
const execFile = promisify(execFileCallback);

const proofPaths = new Map<string, string>();

export async function searchStorage(request: LibraryStorageSearchRequest): Promise<LibraryStorageResult[]> {
  switch (request.kind) {
    case 'workItems': {
      const items = registeredWorkItemServices().flatMap((service) => service.archivedItems());
      return filterArchivedWorkItems(items, request, Date.now()).map((item) => ({
        id: item.id,
        kind: 'workItems',
        title: item.text,
        description: item.reason,
        repo: item.repo,
        assignee: item.agent ?? item.assignee.sessionId ?? item.assignee.paneId ?? item.assignee.kind,
        status: item.status,
        timestamp: item.updatedAt,
      }));
    }
    case 'sessions':
      return searchSessions(request);
    case 'openViking':
      return searchOpenViking(request.query ?? '');
    case 'proofs':
      return searchProofs(request.query ?? '');
  }
}

export async function restoreWorkItem(workItemId: string): Promise<void> {
  for (const service of registeredWorkItemServices()) {
    if (service.archivedItems().some((item) => item.id === workItemId)) {
      await service.restore(workItemId);
      return;
    }
  }
  throw new LibraryUserError('Không tìm thấy việc đã lưu trữ để khôi phục.');
}

export async function resolveProofPath(proofId: string): Promise<string> {
  if (!proofPaths.has(proofId)) throw new LibraryUserError('Không tìm thấy tệp minh chứng.');
  try {
    const allowedRoots = await allowedProofRoots();
    return await resolveProofPathFromMap(proofId, proofPaths, allowedRoots, (value) => fs.realpath(value));
  } catch {
    throw new LibraryUserError('Đường dẫn tệp minh chứng không hợp lệ hoặc tệp không còn tồn tại.');
  }
}

async function searchSessions(request: LibraryStorageSearchRequest): Promise<LibraryStorageResult[]> {
  const dbPath = path.join(os.homedir(), '.omp', 'agent', 'activity.db');
  const source = openLedgerSource(dbPath);
  try {
    const sessions = source.sessionRows();
    const events = source.eventRows('0000-01-01T00:00:00.000Z');
    const transcriptPaths = await findSessionTranscripts(sessions.map((session) => session.sessionId));
    return filterSessionRows(sessions, events, request, transcriptPaths);
  } finally {
    source.close();
  }
}

async function findSessionTranscripts(sessionIds: readonly string[]): Promise<Map<string, string>> {
  const wanted = new Set(sessionIds);
  const matches = new Map<string, string>();
  const roots = [
    path.join(os.homedir(), '.omp', 'agent', 'sessions'),
    path.join(os.homedir(), '.claude', 'projects'),
  ];
  for (const root of roots) {
    const directories = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const directory of directories.slice(0, 2000)) {
      if (!directory.isDirectory()) continue;
      const projectPath = path.join(root, directory.name);
      const files = await fs.readdir(projectPath, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const name = file.name.slice(0, -'.jsonl'.length);
        const separator = name.lastIndexOf('_');
        const sessionId = name.slice(separator + 1);
        if (wanted.has(sessionId)) matches.set(sessionId, path.join(projectPath, file.name));
      }
    }
  }
  return matches;
}

async function searchOpenViking(query: string): Promise<LibraryStorageResult[]> {
  const normalizedQuery = query.slice(0, 200).trim();
  if (normalizedQuery === '') return [];
  try {
    const help = await execFile(process.platform === 'win32' ? 'ov.exe' : 'ov', ['find', '--help'], { timeout: 20_000, windowsHide: true, encoding: 'utf8' });
    const supportsJson = `${help.stdout}\n${help.stderr}`.includes('--output') && `${help.stdout}\n${help.stderr}`.includes('json');
    const args = ['find', normalizedQuery, '-n', '10'];
    if (supportsJson) args.push('--output', 'json');
    const result = await execFile(process.platform === 'win32' ? 'ov.exe' : 'ov', args, { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return parseOpenVikingOutput(result.stdout);
  } catch {
    throw new LibraryUserError('Không thể tìm trong OpenViking. Hãy kiểm tra công cụ ov rồi thử lại.');
  }
}

async function searchProofs(query: string): Promise<LibraryStorageResult[]> {
  const paths = await listProofFiles();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results: LibraryStorageResult[] = [];
  for (const filePath of paths) {
    const fileName = path.basename(filePath);
    if (normalizedQuery && !filePath.toLocaleLowerCase().includes(normalizedQuery)) continue;
    const id = randomUUID();
    if (proofPaths.size >= LIBRARY_PROOF_PATH_CACHE_MAX) {
      const oldest = proofPaths.keys().next().value;
      if (oldest !== undefined) proofPaths.delete(oldest);
    }
    proofPaths.set(id, filePath);
    const extension = path.extname(filePath).toLocaleLowerCase();
    results.push({
      id,
      kind: 'proofs',
      title: fileName,
      description: fileName,
      proofUrl: `/api/library/proofs/${encodeURIComponent(id)}`,
      mediaType: LIBRARY_PROOF_MEDIA_TYPE_BY_EXTENSION[extension],
      timestamp: (await fs.stat(filePath)).mtime.toISOString(),
    });
  }
  return results;
}

async function listProofFiles(): Promise<string[]> {
  const roots = await proofRoots();
  const found: string[] = [];
  for (const reportsRoot of roots) {
    await visitReports(reportsRoot, found, 0);
    if (found.length >= LIBRARY_PROOF_MAX_FILES) break;
  }
  return found;
}

async function visitReports(directory: string, found: string[], depth: number): Promise<void> {
  if (depth > LIBRARY_PROOF_MAX_DEPTH || found.length >= LIBRARY_PROOF_MAX_FILES) return;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (found.length >= LIBRARY_PROOF_MAX_FILES) return;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visitReports(candidate, found, depth + 1);
    } else if (entry.isFile() && Object.hasOwn(LIBRARY_PROOF_MEDIA_TYPE_BY_EXTENSION, path.extname(entry.name).toLocaleLowerCase())) {
      found.push(candidate);
    }
  }
}

async function allowedProofRoots(): Promise<string[]> {
  const projectRoot = await fs.realpath('V:/Duancanhan/Project_QuanLyGiaiDau').catch(() => null);
  if (projectRoot === null) return [];
  const roots: string[] = [];
  for (const reportsRoot of await proofRoots()) {
    const repoRoot = await fs.realpath(path.dirname(path.dirname(reportsRoot))).catch(() => null);
    if (repoRoot !== null && proofPathIsWithinRoot(repoRoot, projectRoot)) roots.push(repoRoot);
  }
  return roots;
}

async function proofRoots(): Promise<string[]> {
  const projectRoot = 'V:/Duancanhan/Project_QuanLyGiaiDau';
  const roots: string[] = [];
  for (const repository of LIBRARY_PROOF_REPOSITORIES) {
    const repoRoot = path.join(projectRoot, repository);
    roots.push(path.join(repoRoot, 'build', 'reports'));
    const worktrees = path.join(projectRoot, `${repository}.worktrees`);
    const entries = await fs.readdir(worktrees, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(path.join(worktrees, entry.name, 'build', 'reports'));
    }
  }
  return roots;
}
