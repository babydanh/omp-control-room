import { describe, expect, it } from 'vitest';

import { CloudControl, type CloudControlDeps, type InstaboxResult } from '../src/fleet/cloudControl.js';

function fakeCloud() {
  const calls: { args: readonly string[]; home: string; input?: string }[] = [];
  const result: InstaboxResult = { code: 0, stdout: '[{"name":"cloud-a"}]', stderr: '' };
  const deps: CloudControlDeps = {
    listConfigHomes: async () => ['/config'],
    run: async (args, home, input) => {
      calls.push({ args, home, ...(input === undefined ? {} : { input }) });
      return args[0] === 'ls' ? result : { code: 0, stdout: '', stderr: '' };
    },
    launcher: { file: 'instabox', args: [] },
    now: () => 1_000,
    forward: async () => ({ localPort: 40_001, alive: () => true, stop: () => undefined }),
  };
  return { cloud: new CloudControl(deps), calls };
}

describe('CloudControl diff comments', () => {
  it('passes comment text only as stdin to tmux load-buffer, never as shell code', async () => {
    const { cloud, calls } = fakeCloud();
    const content = 'Please fix this; echo INJECTED';
    const snippet = '+broken(); $(touch /tmp/nope)';

    await cloud.sendDiffComment('cloud-a', 'task-1', {
      file: 'src/a.ts',
      line: 12,
      snippet,
      content,
    });

    const exec = calls.find((call) => call.args[0] === 'exec');
    expect(exec).toBeDefined();
    expect(exec?.args.slice(0, 6)).toEqual(['exec', 'cloud-a', '--timeout', '30', '--stdin', '--']);
    const command = exec?.args[6] ?? '';
    expect(command).toContain('tmux load-buffer -b');
    expect(command).toContain('tmux paste-buffer -b');
    expect(command).toContain("tmux send-keys -t 'task-1' Enter");
    expect(command).not.toContain(content);
    expect(command).not.toContain(snippet);
    expect(exec?.input).toBe(`[Nhận xét trên diff] src/a.ts:12\n${snippet}\nNhận xét: ${content}`);
  });

  it('rejects unsafe session names and overlong comments before invoking exec', async () => {
    const { cloud, calls } = fakeCloud();
    const comment = { file: 'src/a.ts', line: 1, snippet: '', content: 'x' };

    await expect(cloud.sendDiffComment('cloud-a', 'bad;id', comment)).rejects.toMatchObject({ code: 'bad_input' });
    await expect(cloud.sendDiffComment('cloud-a', 'task-1', { ...comment, content: 'x'.repeat(4_001) })).rejects.toMatchObject({ code: 'bad_input' });
    expect(calls.some((call) => call.args[0] === 'exec')).toBe(false);
  });
});
