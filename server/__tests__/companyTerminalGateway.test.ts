import { describe, expect, it } from 'vitest';

import { RunnerTerminalGateway } from '../src/company/companyTerminalGateway.js';

const SESSION = 'session-1';
const EPOCH = 2;

/** A gateway over a PTY whose framebuffer is `screen` (raw text, base64 on the wire like the helper's). */
function gateway(screen: () => string): RunnerTerminalGateway {
  return new RunnerTerminalGateway({
    client: {
      write: async () => undefined,
      resize: async () => undefined,
      snapshot: async () => Buffer.from(screen(), 'utf8').toString('base64'),
    },
    isLive: () => true,
    size: () => ({ cols: 120, rows: 32 }),
  });
}

const decode = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

describe('RunnerTerminalGateway', () => {
  it('replays the framebuffer on attach, newer than every frame sent before it', async () => {
    const screen = '\x1b[31mred\x1b[0m line\r\nsecond line\r\n';
    const terminal = gateway(() => screen);
    terminal.nextSeq(SESSION, EPOCH);
    terminal.nextSeq(SESSION, EPOCH);

    const handle = await terminal.attach(SESSION, EPOCH);

    expect(handle.replay?.seq).toBe(3);
    expect(decode(handle.replay?.data ?? '')).toBe(screen);
    expect(terminal.nextSeq(SESSION, EPOCH)).toBe(4);
  });

  it('keeps counting across a detach, so a reattached viewer accepts the new replay', async () => {
    const terminal = gateway(() => 'screen\r\n');
    const first = await terminal.attach(SESSION, EPOCH);
    const lastSeen = terminal.nextSeq(SESSION, EPOCH);
    await terminal.detach(SESSION, EPOCH, first.leaseId);
    terminal.nextSeq(SESSION, EPOCH); // output while nobody watches

    const second = await terminal.attach(SESSION, EPOCH);

    expect(second.replay?.seq).toBeGreaterThan(lastSeen);
  });

  it('replays only the newest lines of a large framebuffer, from a line start', async () => {
    const lines = Array.from(
      { length: 4000 },
      (_, i) => `\x1b[32mline ${i}\x1b[0m ${'x'.repeat(20)}`,
    );
    const terminal = gateway(() => lines.join('\r\n'));

    const replayed = decode((await terminal.attach(SESSION, EPOCH)).replay?.data ?? '');

    expect(Buffer.byteLength(replayed, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(replayed.startsWith('\x1b[32mline ')).toBe(true);
    expect(replayed.endsWith(lines.at(-1) ?? '')).toBe(true);
  });
});
