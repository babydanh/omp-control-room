import { describe, expect, it, vi } from 'vitest';

import type { CloudControl } from '../src/fleet/cloudControl.js';
import { type FleetCommandContext,handleFleetMessage } from '../src/fleet/handler.js';
import type { FleetHubResponse } from '../src/fleet/hubClient.js';

const fleetResponse: FleetHubResponse = {
  now: 1,
  machines: [
    {
      agent_id: 'cloud-a',
      received_at: 1,
      sessions: [],
      repos: [
        {
          path: '/data/home/repo',
          branch: 'feat/one',
          ahead: 1,
          behind: 0,
          dirty_files: [],
        },
      ],
      tmux: [
        {
          name: 'agent-one',
          cwd: '/data/home/repo',
          branch: 'feat/one',
          attached: true,
          idle_seconds: 0,
        },
      ],
    },
  ],
};

function makeContext(sendDiffComment: CloudControl['sendDiffComment']): FleetCommandContext {
  return {
    fleet: { fetchFleet: async () => fleetResponse },
    cloud: { sendDiffComment } as unknown as CloudControl,
    ledger: null,
    privileged: true,
  };
}

describe('fleetCloudCommentSend', () => {
  it('sends only to a tmux session reported for the selected repo branch', async () => {
    const sendDiffComment = vi.fn<CloudControl['sendDiffComment']>(async () => undefined);
    const context = makeContext(sendDiffComment);
    const messages: unknown[] = [];
    const message = {
      type: 'fleetCloudCommentSend',
      requestId: 'request-1',
      machine: 'cloud-a',
      path: '/data/home/repo',
      branch: 'feat/one',
      session: 'agent-one',
      file: 'src/a.ts',
      line: 12,
      snippet: '+line',
      content: 'Please check this',
    };

    expect(handleFleetMessage(message, (sent) => messages.push(sent), context)).toBe(true);
    await vi.waitFor(() => expect(messages).toContainEqual({
      type: 'fleetCommandResult',
      requestId: 'request-1',
      ok: true,
      code: 'success',
    }));
    expect(sendDiffComment).toHaveBeenCalledWith('cloud-a', 'agent-one', {
      file: 'src/a.ts',
      line: 12,
      snippet: '+line',
      content: 'Please check this',
    });

    messages.length = 0;
    await handleFleetMessage(
      { ...message, requestId: 'request-2', session: 'wrong-session' },
      (sent) => messages.push(sent),
      context,
    );
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      type: 'fleetCommandResult',
      requestId: 'request-2',
      ok: false,
    })));
    expect(sendDiffComment).toHaveBeenCalledTimes(1);
  });
});
