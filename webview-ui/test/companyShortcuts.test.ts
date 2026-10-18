import { describe, expect, it } from 'vitest';

import {
  findShortcutId,
  matchShortcut,
  SHORTCUT_GROUP_LABELS,
  type ShortcutDef,
  type ShortcutEvent,
  type ShortcutId,
  shortcutKeysLabel,
  shortcutKeyTokens,
  SHORTCUTS,
  shortcutsByGroup,
} from '../src/company/shortcuts.js';

/** Every id the registry must list, once each. Typed, so a misspelt id fails to compile. */
const ALL_IDS: readonly ShortcutId[] = [
  'board.palette',
  'board.help',
  'board.sidebar',
  'board.sidebarWiden',
  'board.sidebarNarrow',
  'board.menu',
  'board.escape',
  'drawer.widen',
  'drawer.narrow',
  'drawer.min',
  'drawer.max',
  'palette.next',
  'palette.previous',
  'palette.pageDown',
  'palette.pageUp',
  'palette.run',
  'composer.company',
  'composer.newline',
  'composer.send',
  'composer.completeNext',
  'composer.nextSuggestion',
  'composer.previousSuggestion',
  'composer.closePicker',
  'composer.command',
];

function press(key: string, modifiers: Partial<Omit<ShortcutEvent, 'key'>> = {}): ShortcutEvent {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}

const CTRL = { ctrlKey: true };
const META = { metaKey: true };
const SHIFT = { shiftKey: true };
const ALT = { altKey: true };

function definition(id: ShortcutId): ShortcutDef {
  const found = SHORTCUTS.find((def) => def.id === id);
  if (found === undefined) throw new Error(`no shortcut ${id}`);
  return found;
}

function orderOf(id: ShortcutId): number {
  return SHORTCUTS.findIndex((def) => def.id === id);
}

interface ChordCase {
  id: ShortcutId;
  /** Events that must match this id. */
  yes: readonly ShortcutEvent[];
  /** Events that must not match, including the same key with the wrong modifiers. */
  no: readonly ShortcutEvent[];
}

const CHORD_CASES: readonly ChordCase[] = [
  {
    id: 'board.palette',
    yes: [press('k', CTRL), press('K', CTRL), press('k', META)],
    no: [
      press('k'),
      press('k', { ctrlKey: true, shiftKey: true }),
      press('k', { ctrlKey: true, altKey: true }),
      press('j', CTRL),
    ],
  },
  {
    id: 'board.help',
    yes: [press('?'), press('?', SHIFT)],
    no: [press('?', CTRL), press('?', META), press('?', ALT), press('/')],
  },
  {
    id: 'board.sidebar',
    yes: [press('b', CTRL), press('B', CTRL), press('b', META)],
    no: [
      press('b'),
      press('b', { ctrlKey: true, shiftKey: true }),
      press('b', { ctrlKey: true, altKey: true }),
      press('a', CTRL),
    ],
  },
  {
    id: 'board.sidebarWiden',
    yes: [press('ArrowRight'), press('ArrowRight', SHIFT)],
    no: [press('ArrowRight', CTRL), press('ArrowLeft')],
  },
  {
    id: 'board.sidebarNarrow',
    yes: [press('ArrowLeft'), press('ArrowLeft', SHIFT)],
    no: [press('ArrowLeft', META), press('ArrowRight')],
  },
  {
    id: 'board.menu',
    yes: [press('ContextMenu'), press('F10', SHIFT)],
    no: [press('F10'), press('F9', SHIFT), press('Enter', SHIFT)],
  },
  {
    id: 'board.escape',
    yes: [press('Escape')],
    no: [press('Escape', CTRL), press('Escape', SHIFT), press('Esc'), press('Enter')],
  },
  {
    id: 'drawer.widen',
    yes: [press('ArrowLeft'), press('ArrowLeft', SHIFT)],
    no: [press('ArrowLeft', CTRL), press('ArrowRight')],
  },
  {
    id: 'drawer.narrow',
    yes: [press('ArrowRight'), press('ArrowRight', SHIFT)],
    no: [press('ArrowRight', ALT), press('ArrowLeft')],
  },
  {
    id: 'drawer.min',
    yes: [press('Home'), press('Home', SHIFT)],
    no: [press('Home', CTRL), press('End')],
  },
  {
    id: 'drawer.max',
    yes: [press('End'), press('End', SHIFT)],
    no: [press('End', ALT), press('Home')],
  },
  {
    id: 'palette.next',
    yes: [press('ArrowDown')],
    no: [press('ArrowDown', CTRL), press('ArrowDown', SHIFT), press('ArrowUp')],
  },
  {
    id: 'palette.previous',
    yes: [press('ArrowUp')],
    no: [press('ArrowUp', ALT), press('ArrowDown')],
  },
  {
    id: 'palette.pageDown',
    yes: [press('PageDown')],
    no: [press('PageDown', CTRL), press('PageUp')],
  },
  {
    id: 'palette.pageUp',
    yes: [press('PageUp')],
    no: [press('PageUp', SHIFT), press('PageDown')],
  },
  {
    id: 'palette.run',
    yes: [press('Enter')],
    no: [press('Enter', SHIFT), press('Enter', CTRL), press('Tab')],
  },
  {
    id: 'composer.company',
    yes: [
      press('Enter', { ctrlKey: true, shiftKey: true }),
      press('Enter', { metaKey: true, shiftKey: true }),
    ],
    no: [
      press('Enter', CTRL),
      press('Enter', SHIFT),
      press('Enter', { ctrlKey: true, shiftKey: true, altKey: true }),
    ],
  },
  {
    id: 'composer.newline',
    yes: [press('Enter', SHIFT)],
    no: [
      press('Enter'),
      press('Enter', { shiftKey: true, ctrlKey: true }),
      press('Enter', { shiftKey: true, altKey: true }),
    ],
  },
  {
    id: 'composer.send',
    yes: [press('Enter')],
    no: [press('Enter', SHIFT), press('Enter', CTRL), press('Enter', ALT)],
  },
  {
    id: 'composer.completeNext',
    yes: [press('Tab')],
    no: [press('Tab', SHIFT), press('Tab', CTRL)],
  },
  {
    id: 'composer.nextSuggestion',
    yes: [press('ArrowDown')],
    no: [press('ArrowDown', SHIFT), press('ArrowDown', ALT)],
  },
  {
    id: 'composer.previousSuggestion',
    yes: [press('ArrowUp')],
    no: [press('ArrowUp', CTRL), press('ArrowUp', ALT)],
  },
  {
    id: 'composer.closePicker',
    yes: [press('Escape')],
    no: [press('Escape', SHIFT), press('Escape', CTRL)],
  },
  {
    id: 'composer.command',
    yes: [press('/')],
    no: [press('/', CTRL), press('/', SHIFT), press('/', ALT)],
  },
];

describe('SHORTCUTS registry', () => {
  it('lists every id exactly once', () => {
    const ids = SHORTCUTS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ALL_IDS].sort());
  });

  it('gives every entry a label and at least one key token', () => {
    for (const def of SHORTCUTS) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.keys.length).toBeGreaterThan(0);
    }
  });

  it('uses the Vietnamese group labels', () => {
    expect(SHORTCUT_GROUP_LABELS).toEqual({
      board: 'Bảng công việc',
      drawer: 'Khung chi tiết',
      composer: 'Ô nhập tin nhắn',
      palette: 'Tìm nhanh và phím tắt',
    });
  });

  it('gives every id a chord case, so no entry goes untested', () => {
    expect(CHORD_CASES.map((row) => row.id).sort()).toEqual([...ALL_IDS].sort());
  });

  it('blocks character and resize keys while typing, but allows Ctrl+K and Escape', () => {
    expect(definition('board.help').allowWhileTyping).toBe(false);
    expect(definition('board.sidebar').allowWhileTyping).toBe(false);
    expect(definition('board.sidebarWiden').allowWhileTyping).toBe(false);
    expect(definition('drawer.min').allowWhileTyping).toBe(false);
    expect(definition('composer.command').allowWhileTyping).toBe(false);
    expect(definition('board.palette').allowWhileTyping).toBe(true);
    expect(definition('board.escape').allowWhileTyping).toBe(true);
    expect(definition('composer.send').allowWhileTyping).toBe(true);
  });

  it('keeps the composer entries in the order findShortcutId depends on', () => {
    expect(orderOf('composer.company')).toBeLessThan(orderOf('composer.send'));
  });
});

describe('matchShortcut', () => {
  for (const row of CHORD_CASES) {
    it(`${row.id} matches its chord and not the chords near it`, () => {
      for (const event of row.yes) expect(matchShortcut(row.id, event)).toBe(true);
      for (const event of row.no) expect(matchShortcut(row.id, event)).toBe(false);
    });
  }

  it('treats Ctrl and Meta as the same modifier for the palette and sidebar', () => {
    expect(matchShortcut('board.palette', press('k', CTRL))).toBe(
      matchShortcut('board.palette', press('k', META)),
    );
    expect(matchShortcut('board.sidebar', press('b', CTRL))).toBe(
      matchShortcut('board.sidebar', press('b', META)),
    );
  });
});

describe('findShortcutId', () => {
  it('finds the company route for Ctrl+Shift+Enter, not a plain send', () => {
    const event = press('Enter', { ctrlKey: true, shiftKey: true });
    expect(findShortcutId(event, { typing: true, groups: ['composer'] })).toBe('composer.company');
  });

  it('finds composer.send for a bare Enter', () => {
    expect(findShortcutId(press('Enter'), { typing: true, groups: ['composer'] })).toBe(
      'composer.send',
    );
  });

  it('finds composer.newline for Shift+Enter', () => {
    expect(findShortcutId(press('Enter', SHIFT), { typing: true, groups: ['composer'] })).toBe(
      'composer.newline',
    );
  });

  it('leaves Ctrl+Enter and Cmd+Enter to the terminal, not the board', () => {
    expect(findShortcutId(press('Enter', CTRL), { typing: true, groups: ['composer'] })).toBeNull();
    expect(findShortcutId(press('Enter', META), { typing: true, groups: ['composer'] })).toBeNull();
  });

  it('finds completeNext for a bare Tab and no board shortcut for Shift+Tab', () => {
    expect(findShortcutId(press('Tab'), { typing: true, groups: ['composer'] })).toBe(
      'composer.completeNext',
    );
    expect(findShortcutId(press('Tab', SHIFT), { typing: true, groups: ['composer'] })).toBeNull();
  });

  it('finds the suggestion step for ArrowDown and ArrowUp', () => {
    expect(findShortcutId(press('ArrowDown'), { typing: true, groups: ['composer'] })).toBe(
      'composer.nextSuggestion',
    );
    expect(findShortcutId(press('ArrowUp'), { typing: true, groups: ['composer'] })).toBe(
      'composer.previousSuggestion',
    );
  });

  it('finds the picker close for Escape', () => {
    expect(findShortcutId(press('Escape'), { typing: true, groups: ['composer'] })).toBe(
      'composer.closePicker',
    );
  });

  it('returns null for a "?" typed into a field, and board.help when not typing', () => {
    expect(findShortcutId(press('?'), { typing: true })).toBeNull();
    expect(findShortcutId(press('?'), { typing: false })).toBe('board.help');
  });

  it('still fires Ctrl+K while typing', () => {
    expect(findShortcutId(press('k', CTRL), { typing: true })).toBe('board.palette');
  });

  it('returns null for "/" while typing, since it is an ordinary character there', () => {
    expect(findShortcutId(press('/'), { typing: true, groups: ['composer'] })).toBeNull();
    expect(findShortcutId(press('/'), { typing: false, groups: ['composer'] })).toBe(
      'composer.command',
    );
  });

  it('limits the search to the groups given', () => {
    expect(findShortcutId(press('ArrowLeft'), { typing: false, groups: ['drawer'] })).toBe(
      'drawer.widen',
    );
    expect(findShortcutId(press('ArrowLeft'), { typing: false, groups: ['composer'] })).toBeNull();
  });

  it('without groups, returns the first entry in SHORTCUTS order that matches', () => {
    expect(findShortcutId(press('ArrowLeft'), { typing: false })).toBe('board.sidebarNarrow');
    expect(findShortcutId(press('Enter'), { typing: false })).toBe('palette.run');
  });

  it('returns null when no entry matches', () => {
    expect(findShortcutId(press('q'), { typing: false })).toBeNull();
  });
});

describe('shortcutKeyTokens and shortcutKeysLabel', () => {
  it('shows Mac modifiers as symbols, with no separator', () => {
    expect(shortcutKeysLabel(definition('board.palette'), true)).toBe('⌘K');
    expect(shortcutKeysLabel(definition('composer.company'), true)).toBe('⌘⇧↵');
    expect(shortcutKeysLabel(definition('board.menu'), true)).toBe('⇧F10');
    expect(shortcutKeysLabel(definition('composer.newline'), true)).toBe('⇧↵');
  });

  it('joins the names with " + " on other platforms', () => {
    expect(shortcutKeysLabel(definition('board.palette'), false)).toBe('Ctrl + K');
    expect(shortcutKeysLabel(definition('composer.company'), false)).toBe('Ctrl + Shift + Enter');
    expect(shortcutKeysLabel(definition('composer.newline'), false)).toBe('Shift + Enter');
  });

  it('leaves tokens without a Mac symbol unchanged', () => {
    expect(shortcutKeysLabel(definition('board.escape'), true)).toBe('Esc');
    expect(shortcutKeysLabel(definition('palette.pageDown'), true)).toBe('PageDown');
    expect(shortcutKeysLabel(definition('board.help'), true)).toBe('?');
    expect(shortcutKeysLabel(definition('composer.send'), false)).toBe('Enter');
    expect(shortcutKeysLabel(definition('composer.send'), true)).toBe('↵');
  });

  it('gives the sheet one token per key', () => {
    expect(shortcutKeyTokens(definition('composer.company'), true)).toEqual(['⌘', '⇧', '↵']);
    expect(shortcutKeyTokens(definition('composer.company'), false)).toEqual([
      'Ctrl',
      'Shift',
      'Enter',
    ]);
  });
});

describe('shortcutsByGroup', () => {
  it('lists the groups in board, palette, composer, drawer order', () => {
    expect(shortcutsByGroup().map((section) => section.group)).toEqual([
      'board',
      'palette',
      'composer',
      'drawer',
    ]);
  });

  it('labels each section with its shared group label', () => {
    for (const section of shortcutsByGroup()) {
      expect(section.label).toBe(SHORTCUT_GROUP_LABELS[section.group]);
    }
  });

  it('places every shortcut in its own group, and every id exactly once', () => {
    const sections = shortcutsByGroup();
    const listed = sections.flatMap((section) => section.shortcuts.map((def) => def.id));
    expect([...listed].sort()).toEqual([...ALL_IDS].sort());
    for (const section of sections) {
      for (const def of section.shortcuts) expect(def.group).toBe(section.group);
    }
  });
});
