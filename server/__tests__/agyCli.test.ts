import { describe, expect, it } from 'vitest';

import { agyWorkerArgs, parseAgyStreamLine } from '../src/company/agyCode/agyCli.js';

describe('agyWorkerArgs', () => {
  it('uses stream-json, text stdin, and the 30-minute worker timeout without permission bypass', () => {
    expect(agyWorkerArgs()).toEqual([
      '--output-format',
      'stream-json',
      '--input-format',
      'text',
      '--print-timeout',
      '30m',
    ]);
  });

  it('continues a conversation when one is given', () => {
    expect(agyWorkerArgs(undefined, 'conv-1').slice(-2)).toEqual(['--conversation', 'conv-1']);
  });
});

describe('parseAgyStreamLine', () => {
  it('reads the init conversation id, beside init as agy 1.x writes it or inside it', () => {
    expect(parseAgyStreamLine(JSON.stringify({ event: 'init', conversation_id: 'chat-2', init: { cwd: 'V:/r' } }))).toEqual({
      kind: 'init',
      conversationId: 'chat-2',
    });
    expect(parseAgyStreamLine(JSON.stringify({ event: 'init', init: { conversation_id: 'chat-1' } }))).toEqual({
      kind: 'init',
      conversationId: 'chat-1',
    });
  });

  it('reads the actions headless agy denied', () => {
    const line = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
    expect(parseAgyStreamLine(line)).toMatchObject({ deniedActions: [{ action: 'command', displayName: 'RunCommand' }] });
  });

  it('formats step progress from step type and text delta', () => {
    expect(
      parseAgyStreamLine(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_type: 'agent_response', text_delta: 'Đang sửa lỗi' },
        }),
      ),
    ).toEqual({ kind: 'progress', text: 'agent_response: Đang sửa lỗi' });
  });

  it('reads the result status, response, usage, and turn count', () => {
    expect(
      parseAgyStreamLine(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: 'Xong', usage: { input_tokens: 12 }, num_turns: 3 },
        }),
      ),
    ).toEqual({
      kind: 'result',
      status: 'SUCCESS',
      response: 'Xong',
      usage: { input_tokens: 12 },
      numTurns: 3,
    });
  });

  it('ignores malformed and unknown lines', () => {
    expect(parseAgyStreamLine('{')).toBeUndefined();
    expect(parseAgyStreamLine('{"event":"unknown"}')).toBeUndefined();
  });
});
