import { describe, expect, it } from 'vitest';

import { terminalClipboardKey } from '../src/company/terminalKeys.js';

const key = (init: Partial<Parameters<typeof terminalClipboardKey>[0]>) => ({
  type: 'keydown',
  key: 'c',
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...init,
});

describe('terminal clipboard keys', () => {
  it('copies on Ctrl+C only while text is selected, so an empty Ctrl+C still interrupts', () => {
    expect(terminalClipboardKey(key({}), true)).toBe('copy');
    expect(terminalClipboardKey(key({}), false)).toBeNull();
  });

  it('copies on Ctrl+Shift+C with a selection and passes it through without one', () => {
    expect(terminalClipboardKey(key({ shiftKey: true, key: 'C' }), true)).toBe('copy');
    expect(terminalClipboardKey(key({ shiftKey: true, key: 'C' }), false)).toBeNull();
  });

  it('leaves Ctrl+V and Ctrl+Shift+V to the browser paste, never sending a literal ^V', () => {
    expect(terminalClipboardKey(key({ key: 'v' }), false)).toBe('paste');
    expect(terminalClipboardKey(key({ key: 'V', shiftKey: true }), true)).toBe('paste');
  });

  it('ignores key-up, other keys, and chords with Alt or Meta', () => {
    expect(terminalClipboardKey(key({ type: 'keyup' }), true)).toBeNull();
    expect(terminalClipboardKey(key({ key: 'x' }), true)).toBeNull();
    expect(terminalClipboardKey(key({ altKey: true }), true)).toBeNull();
    expect(terminalClipboardKey(key({ metaKey: true, ctrlKey: false }), true)).toBeNull();
  });
});
