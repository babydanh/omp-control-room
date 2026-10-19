import * as http from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  fetchLoopbackJson,
  parsePsProcessRows,
  parseWindowsProcessRows,
  type ProcessRow,
  readProcessTreeMemoryBytes,
  treeWorkingSetBytes,
} from '../src/company/browserReaperProbes.js';
import type { QuotaRunner, QuotaRunnerRequest } from '../src/company/quotaService.js';
import { BROWSER_REAPER_MEMORY_TIMEOUT_MS } from '../src/constants.js';

const KIB = 1024;

function runnerReturning(
  stdout: string,
  exitCode: number | null = 0,
  timedOut = false,
): { runner: QuotaRunner; requests: QuotaRunnerRequest[] } {
  const requests: QuotaRunnerRequest[] = [];
  const runner: QuotaRunner = async (request) => {
    requests.push(request);
    return { stdout, stderr: '', exitCode, timedOut };
  };
  return { runner, requests };
}

describe('process listing parsers', () => {
  it('reads a Windows listing that is an array, with a byte-order mark', () => {
    const json =
      '\uFEFF[{"ProcessId":10,"ParentProcessId":1,"WorkingSetSize":1000},{"ProcessId":11,"ParentProcessId":10,"WorkingSetSize":2000}]';
    expect(parseWindowsProcessRows(json)).toEqual([
      { pid: 10, ppid: 1, workingSetBytes: 1000 },
      { pid: 11, ppid: 10, workingSetBytes: 2000 },
    ]);
  });

  it('reads a single-object Windows listing and skips rows with missing fields', () => {
    expect(
      parseWindowsProcessRows('{"ProcessId":7,"ParentProcessId":3,"WorkingSetSize":5}'),
    ).toEqual([{ pid: 7, ppid: 3, workingSetBytes: 5 }]);
    expect(
      parseWindowsProcessRows('[{"ProcessId":"x","ParentProcessId":1,"WorkingSetSize":1}]'),
    ).toEqual([]);
    expect(parseWindowsProcessRows('not json')).toEqual([]);
  });

  it('reads ps columns with RSS in KiB and skips lines that are not three numbers', () => {
    expect(parsePsProcessRows('  101     1  2048\nnoise here\n  102   101  4\n')).toEqual([
      { pid: 101, ppid: 1, workingSetBytes: 2048 * KIB },
      { pid: 102, ppid: 101, workingSetBytes: 4 * KIB },
    ]);
  });
});

describe('treeWorkingSetBytes', () => {
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 1, workingSetBytes: 100 },
    { pid: 11, ppid: 10, workingSetBytes: 200 },
    { pid: 12, ppid: 10, workingSetBytes: 300 },
    { pid: 13, ppid: 11, workingSetBytes: 400 },
    { pid: 20, ppid: 1, workingSetBytes: 9000 },
  ];

  it('sums the root and every descendant, and nothing outside the tree', () => {
    expect(treeWorkingSetBytes(rows, 10)).toBe(100 + 200 + 300 + 400);
  });

  it('returns 0 when the root is not listed', () => {
    expect(treeWorkingSetBytes(rows, 999)).toBe(0);
  });

  it('terminates on a cycle in the parent links', () => {
    const cyclic: ProcessRow[] = [
      { pid: 10, ppid: 11, workingSetBytes: 1 },
      { pid: 11, ppid: 10, workingSetBytes: 2 },
    ];
    expect(treeWorkingSetBytes(cyclic, 10)).toBe(3);
  });
});

describe('readProcessTreeMemoryBytes', () => {
  it('lists processes with ps on Linux and macOS, without a shell', async () => {
    const { runner, requests } = runnerReturning(
      '  10     1  1024\n  11    10  2048\n  99     1  4096\n',
    );
    const bytes = await readProcessTreeMemoryBytes(10, runner, 'V:/work', 'linux');

    expect(bytes).toBe((1024 + 2048) * KIB);
    expect(requests).toEqual([
      {
        executable: 'ps',
        argv: ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='],
        cwd: 'V:/work',
        timeoutMs: BROWSER_REAPER_MEMORY_TIMEOUT_MS,
      },
    ]);
  });

  it('reads Win32_Process through PowerShell on Windows', async () => {
    const { runner, requests } = runnerReturning(
      '[{"ProcessId":10,"ParentProcessId":1,"WorkingSetSize":1000},{"ProcessId":11,"ParentProcessId":10,"WorkingSetSize":2000}]',
    );
    const bytes = await readProcessTreeMemoryBytes(10, runner, 'V:/work', 'win32');

    expect(bytes).toBe(3000);
    expect(requests[0]?.executable).toBe('powershell.exe');
    expect(requests[0]?.argv).toContain('-Command');
  });

  it('reports 0 when the listing fails, times out, or the runner throws', async () => {
    const failed = runnerReturning('', 1);
    expect(await readProcessTreeMemoryBytes(10, failed.runner, 'V:/work', 'linux')).toBe(0);

    const timedOut = runnerReturning('', null, true);
    expect(await readProcessTreeMemoryBytes(10, timedOut.runner, 'V:/work', 'linux')).toBe(0);

    const throwing: QuotaRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    expect(await readProcessTreeMemoryBytes(10, throwing, 'V:/work', 'linux')).toBe(0);
  });
});

describe('fetchLoopbackJson', () => {
  it('refuses any host but 127.0.0.1 before touching the network', async () => {
    await expect(fetchLoopbackJson('http://10.0.0.5:9222/json/list', 1000)).rejects.toThrow(
      'non-loopback',
    );
    await expect(fetchLoopbackJson('http://localhost:9222/json/list', 1000)).rejects.toThrow(
      'non-loopback',
    );
  });

  it('parses a loopback JSON body, and rejects a non-2xx status', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/json/list') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([{ type: 'page' }]));
        return;
      }
      response.writeHead(500);
      response.end('boom');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : 0;
    try {
      await expect(fetchLoopbackJson(`http://127.0.0.1:${port}/json/list`, 2000)).resolves.toEqual([
        { type: 'page' },
      ]);
      await expect(fetchLoopbackJson(`http://127.0.0.1:${port}/missing`, 2000)).rejects.toThrow(
        'HTTP 500',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
