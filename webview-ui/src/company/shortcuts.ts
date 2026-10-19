/**
 * shortcuts: the company board's key bindings as data. Each entry names one
 * binding, the surface that owns it, the keys it shows, and a pure predicate on
 * the key event. The keyboard sheet lists this table, and handlers ask
 * matchShortcut rather than comparing key names, so the sheet cannot drift from
 * what the code answers.
 *
 * Matchers are key-only. A condition that depends on state (a caret on the
 * first line, an open picker, a busy session) stays in the owner's handler,
 * which then asks for the id it needs. Several entries share a key (Enter,
 * Escape, the arrows), so findShortcutId returns the first match in SHORTCUTS
 * order; a listener passes `groups` for the surface that owns the key.
 */

export type ShortcutGroup = 'board' | 'drawer' | 'composer' | 'palette';

export type ShortcutId =
  | 'board.palette'
  | 'board.help'
  | 'board.sidebar'
  | 'board.files'
  | 'board.ledger'
  | 'board.sidebarWiden'
  | 'board.sidebarNarrow'
  | 'board.menu'
  | 'board.escape'
  | 'drawer.widen'
  | 'drawer.narrow'
  | 'drawer.min'
  | 'drawer.max'
  | 'palette.next'
  | 'palette.previous'
  | 'palette.pageDown'
  | 'palette.pageUp'
  | 'palette.run'
  | 'composer.company'
  | 'composer.squad'
  | 'composer.newline'
  | 'composer.send'
  | 'composer.completeNext'
  | 'composer.nextSuggestion'
  | 'composer.previousSuggestion'
  | 'composer.closePicker'
  | 'composer.command';

/** The parts of a key event a binding reads; a KeyboardEvent satisfies it. */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutDef {
  id: ShortcutId;
  group: ShortcutGroup;
  /** Vietnamese description shown in the sheet. */
  label: string;
  /** Display tokens for non-Mac, e.g. ['Ctrl','K']; for Mac the matcher is the same (meta counts as Ctrl) and display uses ⌘. */
  keys: readonly string[];
  /** Whether this shortcut still fires while the focus is in a text field (input, textarea, contenteditable, xterm). */
  allowWhileTyping: boolean;
  /** Pure predicate on the key event. Must not read the DOM. */
  match: (event: ShortcutEvent) => boolean;
}

export const SHORTCUT_GROUP_LABELS: Readonly<Record<ShortcutGroup, string>> = {
  board: 'Bảng công việc',
  drawer: 'Khung chi tiết',
  composer: 'Ô nhập tin nhắn',
  palette: 'Tìm nhanh và phím tắt',
};

/** No modifier held. */
function bare(event: ShortcutEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

/** Ctrl or Cmd, and no Shift or Alt: the same chord on every platform. */
function primary(event: ShortcutEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
}

/** Ctrl or Cmd with Shift, and no Alt: a second chord that stays clear of the browser's own keys. */
function primaryShift(event: ShortcutEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
}

/**
 * A key that a resize grip answers, with Shift allowed: the grips take Shift as
 * a larger step, or ignore it. Ctrl, Cmd and Alt chords are not the grip's.
 */
function withOptionalShift(event: ShortcutEvent, key: string): boolean {
  return event.key === key && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Order matters: findShortcutId returns the first match. A more specific chord
 * comes before the plain key it contains (Ctrl+Shift+Enter before Enter),
 * and a contextual entry comes before the plain one it shares a key with.
 */
export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: 'board.palette',
    group: 'board',
    label: 'Mở tìm nhanh',
    keys: ['Ctrl', 'K'],
    allowWhileTyping: true,
    match: (event) => primary(event) && event.key.toLowerCase() === 'k',
  },
  {
    id: 'board.help',
    group: 'board',
    label: 'Xem danh sách phím tắt',
    keys: ['?'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, '?'),
  },
  {
    id: 'board.sidebar',
    group: 'board',
    label: 'Thu gọn hoặc mở rộng đàn agent',
    keys: ['Ctrl', 'B'],
    allowWhileTyping: false,
    match: (event) => primary(event) && event.key.toLowerCase() === 'b',
  },
  {
    id: 'board.files',
    group: 'board',
    label: 'Mở hoặc đóng tệp',
    keys: ['Ctrl', 'Shift', 'F'],
    allowWhileTyping: false,
    match: (event) => primaryShift(event) && event.key.toLowerCase() === 'f',
  },
  {
    id: 'board.ledger',
    group: 'board',
    label: 'Mở hoặc đóng cây git',
    keys: ['Ctrl', 'Shift', 'L'],
    allowWhileTyping: false,
    match: (event) => primaryShift(event) && event.key.toLowerCase() === 'l',
  },
  // The agent sidebar's resize edge takes the arrows while it has focus.
  {
    id: 'board.sidebarWiden',
    group: 'board',
    label: 'Mở rộng đàn agent (khi đứng ở cạnh kéo)',
    keys: ['→'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, 'ArrowRight'),
  },
  {
    id: 'board.sidebarNarrow',
    group: 'board',
    label: 'Thu hẹp đàn agent (khi đứng ở cạnh kéo)',
    keys: ['←'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, 'ArrowLeft'),
  },
  {
    id: 'board.menu',
    group: 'board',
    label: 'Mở menu của dòng đang chọn (hoặc phím Menu)',
    keys: ['Shift', 'F10'],
    allowWhileTyping: false,
    // Mirrors agentMenuTriggers: the context-menu key, or Shift+F10.
    match: (event) => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey),
  },
  {
    id: 'board.escape',
    group: 'board',
    label: 'Đóng tìm nhanh, phím tắt hoặc đàn agent trên điện thoại',
    keys: ['Esc'],
    allowWhileTyping: true,
    match: (event) => event.key === 'Escape' && bare(event),
  },
  {
    id: 'drawer.widen',
    group: 'drawer',
    label: 'Mở rộng khung chi tiết (Shift: bước lớn hơn)',
    keys: ['←'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, 'ArrowLeft'),
  },
  {
    id: 'drawer.narrow',
    group: 'drawer',
    label: 'Thu hẹp khung chi tiết (Shift: bước lớn hơn)',
    keys: ['→'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, 'ArrowRight'),
  },
  {
    id: 'drawer.min',
    group: 'drawer',
    label: 'Về chiều rộng nhỏ nhất',
    keys: ['Home'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, 'Home'),
  },
  {
    id: 'drawer.max',
    group: 'drawer',
    label: 'Mở hết chiều rộng còn lại',
    keys: ['End'],
    allowWhileTyping: false,
    match: (event) => withOptionalShift(event, 'End'),
  },
  {
    id: 'palette.next',
    group: 'palette',
    label: 'Mục kế tiếp',
    keys: ['↓'],
    allowWhileTyping: true,
    match: (event) => event.key === 'ArrowDown' && bare(event),
  },
  {
    id: 'palette.previous',
    group: 'palette',
    label: 'Mục trước đó',
    keys: ['↑'],
    allowWhileTyping: true,
    match: (event) => event.key === 'ArrowUp' && bare(event),
  },
  {
    id: 'palette.pageDown',
    group: 'palette',
    label: 'Nhảy 5 dòng xuống',
    keys: ['PageDown'],
    allowWhileTyping: true,
    match: (event) => event.key === 'PageDown' && bare(event),
  },
  {
    id: 'palette.pageUp',
    group: 'palette',
    label: 'Nhảy 5 dòng lên',
    keys: ['PageUp'],
    allowWhileTyping: true,
    match: (event) => event.key === 'PageUp' && bare(event),
  },
  {
    id: 'palette.run',
    group: 'palette',
    label: 'Mở mục đang chọn',
    keys: ['Enter'],
    allowWhileTyping: true,
    match: (event) => event.key === 'Enter' && bare(event),
  },
  {
    id: 'composer.company',
    group: 'composer',
    label: 'Giao cho công ty',
    keys: ['Ctrl', 'Shift', 'Enter'],
    allowWhileTyping: true,
    match: (event) =>
      event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey,
  },
  {
    id: 'composer.squad',
    group: 'composer',
    label: 'Giao cho đội',
    keys: ['Ctrl', 'Alt', 'Enter'],
    allowWhileTyping: true,
    match: (event) =>
      event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey,
  },
  {
    id: 'composer.newline',
    group: 'composer',
    label: 'Xuống dòng',
    keys: ['Shift', 'Enter'],
    allowWhileTyping: true,
    match: (event) =>
      event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey,
  },
  // Key-only: the handler also skips a send while an IME is composing.
  {
    id: 'composer.send',
    group: 'composer',
    label: 'Gửi khi phiên đang rảnh',
    keys: ['Enter'],
    allowWhileTyping: true,
    match: (event) => event.key === 'Enter' && bare(event),
  },
  // Key-only: the handler checks that a completion row is showing.
  {
    id: 'composer.completeNext',
    group: 'composer',
    label: 'Chọn gợi ý đang sáng',
    keys: ['Tab'],
    allowWhileTyping: true,
    match: (event) => event.key === 'Tab' && bare(event),
  },
  // Key-only: the handler checks that a completion row is showing.
  {
    id: 'composer.nextSuggestion',
    group: 'composer',
    label: 'Gợi ý kế tiếp',
    keys: ['↓'],
    allowWhileTyping: true,
    match: (event) => event.key === 'ArrowDown' && bare(event),
  },
  // Key-only: the handler checks that a completion row is showing.
  {
    id: 'composer.previousSuggestion',
    group: 'composer',
    label: 'Gợi ý trước đó',
    keys: ['↑'],
    allowWhileTyping: true,
    match: (event) => event.key === 'ArrowUp' && bare(event),
  },
  // Key-only: the handler checks that the suggestion picker is open.
  {
    id: 'composer.closePicker',
    group: 'composer',
    label: 'Đóng danh sách gợi ý',
    keys: ['Esc'],
    allowWhileTyping: true,
    match: (event) => event.key === 'Escape' && bare(event),
  },
  {
    id: 'composer.command',
    group: 'composer',
    label: 'Gõ lệnh omp ở đầu dòng',
    keys: ['/'],
    allowWhileTyping: false,
    match: (event) => event.key === '/' && bare(event),
  },
];

const GROUP_ORDER: readonly ShortcutGroup[] = ['board', 'palette', 'composer', 'drawer'];

const MAC_SYMBOLS: Readonly<Partial<Record<string, string>>> = {
  Ctrl: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Enter: '↵',
};

export function matchShortcut(id: ShortcutId, event: ShortcutEvent): boolean {
  const def = SHORTCUTS.find((entry) => entry.id === id);
  return def !== undefined && def.match(event);
}

/**
 * The first entry, in SHORTCUTS order, that matches the event. While typing, only
 * entries that allow it are considered; `groups` limits the search to the surfaces
 * a listener owns.
 */
export function findShortcutId(
  event: ShortcutEvent,
  options: { typing: boolean; groups?: readonly ShortcutGroup[] },
): ShortcutId | null {
  for (const def of SHORTCUTS) {
    if (options.groups !== undefined && !options.groups.includes(def.group)) continue;
    if (options.typing && !def.allowWhileTyping) continue;
    if (def.match(event)) return def.id;
  }
  return null;
}

/** The keys as the sheet shows them: Mac modifiers become symbols; elsewhere the names stay. */
export function shortcutKeyTokens(def: ShortcutDef, isMac: boolean): readonly string[] {
  if (!isMac) return def.keys;
  return def.keys.map((token) => MAC_SYMBOLS[token] ?? token);
}

/** Mac joins symbols with nothing (⌘⇧↵); elsewhere the names are spaced (Ctrl + Shift + Enter). */
export function shortcutKeysLabel(def: ShortcutDef, isMac: boolean): string {
  return shortcutKeyTokens(def, isMac).join(isMac ? '' : ' + ');
}

export function shortcutsByGroup(): readonly {
  group: ShortcutGroup;
  label: string;
  shortcuts: readonly ShortcutDef[];
}[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: SHORTCUT_GROUP_LABELS[group],
    shortcuts: SHORTCUTS.filter((def) => def.group === group),
  }));
}
