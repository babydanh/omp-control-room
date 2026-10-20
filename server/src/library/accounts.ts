import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { LibraryAccount, LibraryAccountLogin, LibraryCredential } from '../../../core/src/messages.js';
import { LibraryUserError } from './libraryError.js';

const ACCOUNT_CACHE_MS = 60_000;
const AGY_MODELS_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 10_000;
// Resolved per call: tests and hosts may stub the home directory after this module loads.
const databaseFile = (): string => join(homedir(), '.omp', 'agent', 'agent.db');

// Keep this query limited to display-safe credential metadata; never read credential payloads.
export const OMP_CREDENTIALS_SQL = `
  SELECT c.provider, c.credential_type, c.disabled_cause, c.updated_at,
         b.blocked_until_ms
  FROM auth_credentials AS c
  LEFT JOIN auth_credential_blocks AS b ON b.credential_id = c.id
`;

type ClaudeStatus = {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  orgName?: string;
  email?: string;
};

let cachedAccounts: LibraryAccount[] | undefined;
let cacheUpdatedAt = 0;

export function maskAccountEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1) return undefined;
  return `${email.slice(0, Math.min(2, separator))}***${email.slice(separator)}`;
}

export function mapClaudeStatus(output: string): ClaudeStatus {
  const value: unknown = JSON.parse(output);
  if (typeof value !== 'object' || value === null || !('loggedIn' in value)) {
    throw new Error('Không đọc được trạng thái Claude Code.');
  }
  const status = value as Record<string, unknown>;
  if (typeof status.loggedIn !== 'boolean') throw new Error('Không đọc được trạng thái Claude Code.');
  return {
    loggedIn: status.loggedIn,
    authMethod: typeof status.authMethod === 'string' ? status.authMethod : undefined,
    subscriptionType: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
    orgName: typeof status.orgName === 'string' ? status.orgName : undefined,
    email: maskAccountEmail(typeof status.email === 'string' ? status.email : undefined),
  };
}

export function mapAgyModels(output: string): number {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-|+ ]+$/.test(line) && !/^model(?:\s|$)/i.test(line))
    .length;
}

export function isValidOmpProvider(provider: string): boolean {
  return /^[a-z0-9-]+$/.test(provider);
}

export function isAllowedOmpProvider(provider: string, providers: ReadonlySet<string>): boolean {
  return isValidOmpProvider(provider) && providers.has(provider);
}

export async function readAccounts(refresh: boolean): Promise<LibraryAccount[]> {
  if (!refresh && cachedAccounts !== undefined && Date.now() - cacheUpdatedAt < ACCOUNT_CACHE_MS) {
    return cachedAccounts;
  }
  const [claude, agy, omp] = await Promise.all([
    readClaudeAccount(),
    readAgyAccount(),
    readOmpAccount(),
  ]);
  const accounts = [claude, agy, omp];
  cachedAccounts = accounts;
  cacheUpdatedAt = Date.now();
  return accounts;
}

export async function openLogin(
  tool: LibraryAccountLogin['tool'],
  provider?: string,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new LibraryUserError('Mở cửa sổ đăng nhập chỉ được hỗ trợ trên Windows.');
  }

  let args: string[];
  if (tool === 'claude') {
    args = ['claude', 'auth', 'login'];
  } else if (tool === 'agy') {
    args = ['agy'];
  } else if (tool === 'omp') {
    if (provider === undefined) {
      throw new LibraryUserError('Nhà cung cấp omp không hợp lệ.');
    }
    let providers: Set<string>;
    try {
      providers = await readOmpProviders();
    } catch {
      throw new LibraryUserError('Không thể đọc danh sách nhà cung cấp omp.');
    }
    if (!isAllowedOmpProvider(provider, providers)) {
      throw new LibraryUserError('Nhà cung cấp omp không có trong danh sách đã cấu hình.');
    }
    args = ['omp', 'login', provider];
  } else {
    throw new LibraryUserError('Công cụ đăng nhập không hợp lệ.');
  }

  await execute('cmd.exe', ['/c', 'start', '', 'cmd', '/k', ...args], COMMAND_TIMEOUT_MS);
}

async function readClaudeAccount(): Promise<LibraryAccount> {
  try {
    const result = await execute('claude', ['auth', 'status', '--json'], COMMAND_TIMEOUT_MS);
    if (result.code !== 0) {
      return { tool: 'claude', loggedIn: false, reason: 'Không thể đọc trạng thái đăng nhập Claude Code.' };
    }
    const status = mapClaudeStatus(result.stdout);
    return { tool: 'claude', ...status };
  } catch {
    return {
      tool: 'claude',
      loggedIn: false,
      reason: 'Không tìm thấy lệnh Claude Code hoặc không thể đọc trạng thái đăng nhập.',
    };
  }
}

async function readAgyAccount(): Promise<LibraryAccount> {
  try {
    const result = await execute('agy', ['models'], AGY_MODELS_TIMEOUT_MS);
    if (result.code !== 0) {
      return { tool: 'agy', loggedIn: false, reason: 'Không thể đọc danh sách model agy.' };
    }
    const modelCount = mapAgyModels(result.stdout);
    return modelCount > 0
      ? { tool: 'agy', loggedIn: true, modelCount }
      : { tool: 'agy', loggedIn: false };
  } catch {
    return { tool: 'agy', loggedIn: false, reason: 'Không tìm thấy lệnh agy hoặc lệnh đã hết thời gian chờ.' };
  }
}

async function readOmpAccount(): Promise<LibraryAccount> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databaseFile(), { readOnly: true });
    const rows = database.prepare(OMP_CREDENTIALS_SQL).all() as Array<{
      provider: string;
      credential_type: string;
      disabled_cause: string | null;
      updated_at: string | number;
      blocked_until_ms: number | null;
    }>;
    const credentials: LibraryCredential[] = rows.map((row) => ({
      provider: row.provider,
      credentialType: row.credential_type,
      disabled: row.disabled_cause !== null,
      ...(row.disabled_cause === null ? {} : { disabledCause: row.disabled_cause }),
      updatedAt: String(row.updated_at),
      ...(row.blocked_until_ms === null || row.blocked_until_ms === undefined ? {} : { blockedUntilMs: row.blocked_until_ms }),
    }));
    return {
      tool: 'omp',
      loggedIn: credentials.some((credential) => !credential.disabled),
      providers: [...new Set(credentials.map((credential) => credential.provider))],
      credentials,
      updatedAt: credentials.reduce((latest, credential) =>
        credential.updatedAt > latest ? credential.updatedAt : latest, ''),
    };
  } catch {
    return {
      tool: 'omp',
      loggedIn: false,
      reason: 'Không tìm thấy hoặc không thể đọc cơ sở dữ liệu xác thực omp.',
      providers: [],
      credentials: [],
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Closing the read-only status database must not mask its result.
    }
  }
}

async function readOmpProviders(): Promise<Set<string>> {
  const database = new DatabaseSync(databaseFile(), { readOnly: true });
  try {
    const rows = database.prepare('SELECT provider FROM auth_credentials').all() as Array<{ provider: string }>;
    return new Set(rows.map((row) => row.provider).filter(isValidOmpProvider));
  } finally {
    database.close();
  }
}

function execute(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error !== null) {
          const childError = error as NodeJS.ErrnoException & { code?: number | string | null };
          if (typeof childError.code === 'number') {
            resolve({ code: childError.code, stdout });
          } else {
            reject(error);
          }
          return;
        }
        resolve({ code: 0, stdout });
      },
    );
  });
}
