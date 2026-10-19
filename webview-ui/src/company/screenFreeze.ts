/**
 * The freeze that holds a herdr screen still while the reader selects its text. A press
 * inside the screen and a live selection inside it each freeze the view. The view catches
 * up with the newest screen the moment both have ended, so a selection never shifts under
 * the reader's pointer.
 */

export interface ScreenFreezeState {
  readonly pressed: boolean;
  readonly selected: boolean;
}

export type ScreenFreezeEvent =
  | { readonly type: 'press' }
  | { readonly type: 'release' }
  | { readonly type: 'selection'; readonly active: boolean };

export const SCREEN_NOT_FROZEN: ScreenFreezeState = { pressed: false, selected: false };

export function reduceScreenFreeze(
  state: ScreenFreezeState,
  event: ScreenFreezeEvent,
): ScreenFreezeState {
  switch (event.type) {
    case 'press':
      return state.pressed ? state : { ...state, pressed: true };
    case 'release':
      return state.pressed ? { ...state, pressed: false } : state;
    case 'selection':
      return state.selected === event.active ? state : { ...state, selected: event.active };
  }
}

export function isScreenFrozen(state: ScreenFreezeState): boolean {
  return state.pressed || state.selected;
}
