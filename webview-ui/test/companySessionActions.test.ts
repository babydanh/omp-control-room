import { describe, expect, it } from 'vitest';

import {
  sessionControls,
  sessionHoldsWork,
  terminalPolicy,
} from '../src/company/sessionActions.js';

describe('sessionControls', () => {
  it('offers pause for a running session and not resume', () => {
    expect(sessionControls('busy')).toMatchObject({ pause: true, resume: false });
  });

  it('offers interrupt while a turn runs or waits for input, and nowhere else', () => {
    expect(sessionControls('busy')).toMatchObject({ interrupt: true });
    expect(sessionControls('waiting_input')).toMatchObject({ interrupt: true });
    for (const status of ['idle', 'starting', 'paused', 'parked']) {
      expect(sessionControls(status).interrupt).toBe(false);
    }
  });

  it('offers nothing for a status it does not know, rather than a full row of buttons', () => {
    expect(sessionControls('from-a-future-server')).toEqual({
      interrupt: false,
      pause: false,
      resume: false,
      kill: false,
      restart: false,
      archive: false,
    });
  });
});

describe('sessionHoldsWork', () => {
  it('holds work while a run is in flight or a task is attached', () => {
    expect(sessionHoldsWork({ status: 'busy' }, false)).toBe(true);
    expect(sessionHoldsWork({ status: 'pausing' }, false)).toBe(true);
    expect(sessionHoldsWork({ status: 'idle', activeTaskId: 'task-1' }, false)).toBe(true);
  });

  it('holds work while a question waits on the user', () => {
    expect(sessionHoldsWork({ status: 'crashed' }, true)).toBe(true);
  });

  it('holds no work when idle, crashed, or parked with nothing attached', () => {
    expect(sessionHoldsWork({ status: 'idle' }, false)).toBe(false);
    expect(sessionHoldsWork({ status: 'crashed' }, false)).toBe(false);
    expect(sessionHoldsWork({ status: 'parked' }, false)).toBe(false);
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
