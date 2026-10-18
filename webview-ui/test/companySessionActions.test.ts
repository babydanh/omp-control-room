import { describe, expect, it } from 'vitest';

import { sessionControls, terminalPolicy } from '../src/company/sessionActions.js';

describe('sessionControls', () => {
  it('offers pause for a running session and not resume', () => {
    expect(sessionControls('busy')).toMatchObject({ pause: true, resume: false });
  });

  it('offers nothing for a status it does not know, rather than a full row of buttons', () => {
    expect(sessionControls('from-a-future-server')).toEqual({
      pause: false,
      resume: false,
      kill: false,
      restart: false,
      archive: false,
    });
  });
});

describe('terminalPolicy', () => {
  it('attaches the terminal to a live session', () => {
    expect(terminalPolicy('busy')).toEqual({ attach: true, resume: false, message: null });
    expect(terminalPolicy('waiting_input')).toMatchObject({ attach: true });
  });

  it('offers resume, and no terminal, for a parked session', () => {
    expect(terminalPolicy('parked')).toMatchObject({ attach: false, resume: true });
  });

  it('attaches nothing while a session is pausing, stopping or archived', () => {
    for (const status of ['pausing', 'stopping', 'archived']) {
      expect(terminalPolicy(status)).toMatchObject({ attach: false, resume: false });
    }
  });

  it('says so, and attaches nothing, when the status is unknown', () => {
    expect(terminalPolicy('from-a-future-server')).toEqual({
      attach: false,
      resume: false,
      message: 'Trạng thái phiên không xác định, nên không mở bảng điều khiển.',
    });
  });
});
