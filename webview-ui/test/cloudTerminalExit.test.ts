import { describe, expect, it } from 'vitest';

import { exitScreen } from '../src/company/fleet/cloudTerminalExit.js';

describe('exitScreen', () => {
  it('keeps the last few non-empty lines and states why the session ended, with attributes reset', () => {
    const lines = ['', 'old', '[exited]', '', 'Connection to ssh.instabox.sh closed.', '', ''];
    const out = exitScreen(lines, 'Phiên SSH đã đóng (mã 0).');
    expect(out.startsWith('\x1b[0m')).toBe(true);
    expect(out).toContain('[exited]\r\nConnection to ssh.instabox.sh closed.');
    expect(out).toContain('Phiên SSH đã đóng (mã 0).');
  });

  it('caps the kept lines so a long screen does not stay', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const out = exitScreen(lines, 'x');
    expect(out).toContain('line 39');
    expect(out).not.toContain('line 0\r');
    expect(out.split('\r\n').length).toBeLessThanOrEqual(9);
  });
});
