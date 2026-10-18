import { describe, expect, it } from 'vitest';

import { EMPTY_SELECTION } from '../src/company/companyState.js';
import { selectionWith } from '../src/company/selection.js';

const ON_SESSION = { ...EMPTY_SELECTION, sessionId: 'sess-1', taskId: 'task-1' };
const ON_HERDR = { ...EMPTY_SELECTION, herdrPaneId: 'pane-a' };

describe('selectionWith', () => {
  it('naming a herdr pane clears the session it replaces', () => {
    expect(selectionWith(ON_SESSION, { herdrPaneId: 'pane-a' })).toStrictEqual({
      ...ON_SESSION,
      sessionId: null,
      herdrPaneId: 'pane-a',
    });
  });

  it('naming a session clears the herdr pane it replaces', () => {
    expect(selectionWith(ON_HERDR, { sessionId: 'sess-2' })).toStrictEqual({
      ...ON_HERDR,
      sessionId: 'sess-2',
      herdrPaneId: null,
    });
  });

  it('naming a task clears the herdr pane', () => {
    expect(selectionWith(ON_HERDR, { taskId: 'task-2' }).herdrPaneId).toBeNull();
  });

  it('clearing the session clears the herdr pane too, so a new chat has no target left over', () => {
    expect(selectionWith(ON_HERDR, { sessionId: null }).herdrPaneId).toBeNull();
  });

  it('clearing the herdr pane keeps an explicitly named session', () => {
    expect(selectionWith(ON_HERDR, { sessionId: 'sess-3', herdrPaneId: null })).toStrictEqual({
      ...ON_HERDR,
      sessionId: 'sess-3',
      herdrPaneId: null,
    });
  });

  it('an unrelated change leaves the herdr pane alone', () => {
    expect(selectionWith(ON_HERDR, { tab: null })).toStrictEqual({ ...ON_HERDR, tab: null });
  });
});
