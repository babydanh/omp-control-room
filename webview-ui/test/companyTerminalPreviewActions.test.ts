import type { FocusEvent, PointerEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewTarget } from '../src/company/terminalPreview.js';
import { previewTriggers } from '../src/company/terminalPreviewActions.js';

const ROW: PreviewTarget = { kind: 'herdr', paneId: 'pane-a' };

/** Stands in for a row's element; these tests run without a DOM. */
function fakeRow(focusVisible = false) {
  return {
    matches: (selector: string) => focusVisible && selector === ':focus-visible',
  } as unknown as HTMLElement;
}

function pointerEvent(pointerType: string, element: HTMLElement) {
  return { pointerType, currentTarget: element } as unknown as PointerEvent<HTMLElement>;
}

function focusEvent(element: HTMLElement) {
  return { currentTarget: element } as unknown as FocusEvent<HTMLElement>;
}

function recordingActions() {
  return { enter: vi.fn(), leave: vi.fn(), press: vi.fn(), focus: vi.fn(), blur: vi.fn() };
}

describe('previewTriggers onPointerEnter', () => {
  it('opens the preview on a mouse hover', () => {
    const actions = recordingActions();
    const row = fakeRow();

    previewTriggers(actions, ROW).onPointerEnter(pointerEvent('mouse', row));

    expect(actions.enter).toHaveBeenCalledWith(ROW, row);
  });

  it.each(['touch', 'pen'])('ignores %s, which fires pointerenter on tap', (pointerType) => {
    const actions = recordingActions();

    previewTriggers(actions, ROW).onPointerEnter(pointerEvent(pointerType, fakeRow()));

    expect(actions.enter).not.toHaveBeenCalled();
  });
});

describe('previewTriggers other handlers', () => {
  it('still reports pointer down, leave and blur', () => {
    const actions = recordingActions();
    const triggers = previewTriggers(actions, ROW);

    triggers.onPointerDown();
    triggers.onPointerLeave();
    triggers.onBlur();

    expect(actions.press).toHaveBeenCalledWith(ROW);
    expect(actions.leave).toHaveBeenCalledWith(ROW);
    expect(actions.blur).toHaveBeenCalledWith(ROW);
  });

  it('opens on keyboard focus only when the row shows focus-visible', () => {
    const actions = recordingActions();
    const triggers = previewTriggers(actions, ROW);
    const visible = fakeRow(true);

    triggers.onFocus(focusEvent(fakeRow(false)));
    expect(actions.focus).not.toHaveBeenCalled();

    triggers.onFocus(focusEvent(visible));
    expect(actions.focus).toHaveBeenCalledWith(ROW, visible);
  });
});
