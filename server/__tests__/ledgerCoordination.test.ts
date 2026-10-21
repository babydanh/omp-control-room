import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { eventRow, makeService } from './ledgerFixtures.js';

let temp: string;
afterEach(async () => {
  if (temp !== undefined) await fs.rm(temp, { recursive: true, force: true });
});

describe('LedgerService coordination handoffs', () => {
  it('reads root and active OpenSpec handoffs, skips archive, and truncates sections', async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pxl-handoff-'));
    await fs.writeFile(
      path.join(temp, 'HANDOFF.md'),
      `## Mục tiêu\n${'x'.repeat(350)}\n## Trạng thái\nĐang làm\n## Câu hỏi còn mở\nChưa rõ`,
    );
    const changes = path.join(temp, 'openspec', 'changes');
    await fs.mkdir(path.join(changes, 'active'), { recursive: true });
    await fs.mkdir(path.join(changes, 'archive', 'old'), { recursive: true });
    await fs.writeFile(path.join(changes, 'active', 'handoff.md'), '## Trạng thái\nXong');
    await fs.writeFile(
      path.join(changes, 'archive', 'old', 'handoff.md'),
      '## Mục tiêu\nKhông đọc',
    );
    const h = makeService({ data: { events: [eventRow('s', { repo: temp, checkout: temp })] } });
    const result = await h.service.coordination('r1');
    expect(result.handoffs).toHaveLength(2);
    expect(result.handoffs.find((handoff) => handoff.path === 'HANDOFF.md')?.goal).toHaveLength(
      300,
    );
    expect(result.handoffs.map((handoff) => handoff.path)).not.toContain(
      'openspec/changes/archive/old/handoff.md',
    );
    h.service.dispose();
  });
  it('requests messages from the last seven days', async () => {
    const recent = {
      id: 1,
      ts: '2026-04-10 11:00:00',
      toSession: 'b',
      fromSession: 'a',
      relKey: 'msg:1',
      content: 'hi',
      delivered: 1,
      fromKind: 'claude',
      fromCwd: null,
      toKind: 'main',
      toCwd: null,
    };
    const old = { ...recent, id: 2, ts: '2026-04-02 11:00:00' };
    const h = makeService({ data: { agentMessages: [recent, old] } });
    const result = await h.service.coordination('r2');
    expect(result.messages.map((message) => message.id)).toEqual([1]);
    h.service.dispose();
  });
});
