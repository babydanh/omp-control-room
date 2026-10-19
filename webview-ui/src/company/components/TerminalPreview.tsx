/**
 * TerminalPreview: the small floating terminal a hovered session or herdr row
 * opens. Only one preview is open at a time.
 *
 * The open state is decided by the pure reducer in terminalPreview.ts. This
 * provider runs its timers, listens for Escape, scroll and resize, and paints the
 * panel into the body above the drawer. Rows report pointer and keyboard focus
 * through previewTriggers, so the sidebar and the rail need no preview logic.
 *
 * The panel takes the pointer, so its text can be read and scrolled with the wheel.
 *
 * The prompt line sends to the row's agent. While that line holds focus or text, the
 * preview stays open.
 */

import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { sleepingName } from '../agentSidebarView.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_TONE_LABELS, herdrToneFor } from '../herdrView.js';
import { companyRoleLabel } from '../roleProfiles.js';
import type { DrawerSubject } from '../selection.js';
import { terminalPolicy } from '../sessionActions.js';
import { logEntriesFor } from '../sessionLogView.js';
import { sessionStatusLabel } from '../statusLabels.js';
import {
  INITIAL_PREVIEW_STATE,
  placePreview,
  type PreviewEvent,
  previewKey,
  type PreviewRect,
  type PreviewState,
  type PreviewTarget,
  previewTargetOfSubject,
  type PreviewTimer,
  reducePreview,
} from '../terminalPreview.js';
import { type TerminalPreviewActions, TerminalPreviewContext } from '../terminalPreviewActions.js';
import { parseAnsiScreen, tailScreen } from '../terminalScreen.js';
import { useCoalescedFrame } from '../useCoalescedFrame.js';
import { useHerdrScreenWatch } from '../useHerdrScreenWatch.js';
import { useParsedScreen } from '../useParsedScreen.js';
import { useScreenSelection } from '../useScreenSelection.js';
import { PreviewPrompt } from './PreviewPrompt.js';
import { PinnedScreenFrame, ScreenFreezeChip } from './ScreenFrame.js';
import { ScreenView } from './ScreenView.js';
import { TerminalMirror } from './TerminalMirror.js';

/** Newest rows of screen and scrollback a preview keeps; the panel scrolls through them. */
const PREVIEW_HISTORY_ROWS = 400;
/** Log entries a preview reads when the session has no live terminal. */
const PREVIEW_LOG_ENTRIES = 100;
/** How often an open preview checks that its row is still on the page. */
const PREVIEW_ANCHOR_CHECK_MS = 500;

export interface TerminalPreviewProviderProps {
  client: CompanyClient;
  state: CompanyViewState;
  /** What the detail drawer shows; its row gets no preview while it does. */
  drawerSubject: DrawerSubject | null;
  /** The board area the preview stays inside: the rows above the composer, beside the drawer. */
  boardAreaRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function TerminalPreviewProvider({
  client,
  state,
  drawerSubject,
  boardAreaRef,
  children,
}: TerminalPreviewProviderProps) {
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW_STATE);
  const previewRef = useRef<PreviewState>(INITIAL_PREVIEW_STATE);
  const [bounds, setBounds] = useState<PreviewRect | null>(null);
  const timersRef = useRef(new Map<PreviewTimer, number>());
  /** The row element the preview is anchored to; the reducer only keeps its rectangle. */
  const anchorRef = useRef<HTMLElement | null>(null);
  /** The panel element. A press or a scroll inside it belongs to the preview. */
  const panelRef = useRef<HTMLDivElement | null>(null);

  const dispatch = useCallback((event: PreviewEvent): void => {
    const result = reducePreview(previewRef.current, event);
    previewRef.current = result.state;
    setPreview(result.state);
    const timers = timersRef.current;
    for (const effect of result.effects) {
      const pending = timers.get(effect.timer);
      if (pending !== undefined) window.clearTimeout(pending);
      timers.delete(effect.timer);
      if (effect.type === 'schedule') {
        const timer = effect.timer;
        timers.set(
          timer,
          window.setTimeout(() => {
            timers.delete(timer);
            dispatch({ type: 'timer', timer });
          }, effect.delayMs),
        );
      }
    }
  }, []);

  // Stable, so the prompt's pin effect runs only when its pinned state actually changes.
  const onPinChange = useCallback(
    (pinned: boolean): void => dispatch({ type: 'pin', pinned }),
    [dispatch],
  );

  const actions = useMemo<TerminalPreviewActions>(
    () => ({
      enter: (target, element) => {
        anchorRef.current = element;
        setBounds(previewBoundsOf(boardAreaRef.current));
        dispatch({ type: 'enter', target, anchor: rectOf(element) });
      },
      leave: (target) => dispatch({ type: 'leave', target }),
      press: (target) => dispatch({ type: 'press', target }),
      focus: (target, element) => {
        anchorRef.current = element;
        setBounds(previewBoundsOf(boardAreaRef.current));
        dispatch({ type: 'focus', target, anchor: rectOf(element) });
      },
      blur: (target) => dispatch({ type: 'blur', target }),
    }),
    [dispatch, boardAreaRef],
  );

  // Clear any pending timers when the board goes away.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // The drawer's subject keeps its own row's preview shut while the drawer shows it.
  const drawerTarget = previewTargetOfSubject(drawerSubject);
  const drawerKey = drawerTarget === null ? null : previewKey(drawerTarget);
  useEffect(() => {
    dispatch({ type: 'drawer', key: drawerKey });
  }, [drawerKey, dispatch]);

  const openTarget = preview.target;
  useEffect(() => {
    if (openTarget === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      // Escape closes the preview only; the drawer and menus underneath keep theirs.
      event.stopPropagation();
      dispatch({ type: 'escape' });
    };
    const onScroll = (event: Event) => {
      const anchor = anchorRef.current;
      const scrolled = event.target;
      const node = scrolled instanceof Node ? scrolled : null;
      dispatch({
        type: 'scroll',
        // A wheel or drag inside the preview moves its own text, not the row.
        insidePreview: node !== null && panelRef.current?.contains(node) === true,
        // The page, or a container that holds the row, moves the row away from its preview.
        movesRow:
          scrolled === document || (node !== null && anchor !== null && node.contains(anchor)),
      });
    };
    const onResize = () => dispatch({ type: 'close' });
    const onPointerDown = (event: PointerEvent) => {
      // A press inside the preview belongs to it: its scrollbar and text stay usable.
      const pressed = event.target;
      if (pressed instanceof Node && panelRef.current?.contains(pressed) === true) return;
      dispatch({ type: 'dismiss' });
    };
    const checkAnchor = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (anchor !== null && !anchor.isConnected) dispatch({ type: 'close' });
    }, PREVIEW_ANCHOR_CHECK_MS);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.clearInterval(checkAnchor);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [openTarget, dispatch]);

  const anchor = preview.anchor;
  return (
    <TerminalPreviewContext.Provider value={actions}>
      {children}
      {openTarget !== null &&
        anchor !== null &&
        bounds !== null &&
        createPortal(
          // The company scale (spacing, text sizes) and reduced motion live on .company-ui.
          <div className="company-ui">
            <PreviewPanel
              key={previewKey(openTarget)}
              client={client}
              state={state}
              target={openTarget}
              anchor={anchor}
              bounds={bounds}
              panelRef={panelRef}
              onPointerEnter={() => dispatch({ type: 'panelEnter', target: openTarget })}
              onPointerLeave={() => dispatch({ type: 'panelLeave', target: openTarget })}
              onPinChange={onPinChange}
            />
          </div>,
          document.body,
        )}
    </TerminalPreviewContext.Provider>
  );
}

function rectOf(element: HTMLElement): PreviewRect {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

/** The area a preview may cover: the board above the composer, cut short by an open drawer. */
function previewBoundsOf(board: HTMLElement | null): PreviewRect {
  if (board === null)
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const area = rectOf(board);
  const drawer = board.querySelector<HTMLElement>('[data-testid="session-drawer"]');
  if (drawer === null || drawer.getAttribute('aria-hidden') === 'true') return area;
  return { ...area, right: Math.min(area.right, drawer.getBoundingClientRect().left) };
}

function PreviewPanel({
  client,
  state,
  target,
  anchor,
  bounds,
  panelRef,
  onPointerEnter,
  onPointerLeave,
  onPinChange,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  target: PreviewTarget;
  anchor: PreviewRect;
  bounds: PreviewRect;
  panelRef: RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPinChange: (pinned: boolean) => void;
}) {
  const screenRef = useRef<HTMLPreElement>(null);
  const frozen = useScreenSelection(screenRef);
  // A pointer that leaves while a selection is held waits; the preview closes once the hold ends.
  const leftWhileFrozen = useRef(false);
  useEffect(() => {
    if (frozen || !leftWhileFrozen.current) return;
    leftWhileFrozen.current = false;
    onPointerLeave();
  }, [frozen, onPointerLeave]);
  const box = placePreview(anchor, bounds);
  return (
    <div
      ref={panelRef}
      role="group"
      aria-label="Xem trước terminal"
      data-testid="terminal-preview"
      className="company-fade-in fixed z-40 flex flex-col overflow-hidden rounded-(--company-radius-md) border border-hairline bg-raised"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      }}
      onPointerEnter={() => {
        leftWhileFrozen.current = false;
        onPointerEnter();
      }}
      onPointerLeave={() => {
        if (frozen) leftWhileFrozen.current = true;
        else onPointerLeave();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {target.kind === 'herdr' ? (
          <HerdrPreview
            client={client}
            state={state}
            paneId={target.paneId}
            screenRef={screenRef}
            frozen={frozen}
          />
        ) : (
          <SessionPreview client={client} state={state} sessionId={target.sessionId} />
        )}
      </div>
      <PreviewPrompt client={client} state={state} target={target} onPinChange={onPinChange} />
    </div>
  );
}

function HerdrPreview({
  client,
  state,
  paneId,
  screenRef,
  frozen,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  paneId: string;
  screenRef: RefObject<HTMLPreElement | null>;
  frozen: boolean;
}) {
  const agent = state.herdr.agents.find((entry) => entry.paneId === paneId);
  const sleeping = state.herdr.sleeping.find((entry) => entry.paneId === paneId);
  const latest = state.herdr.screens[paneId];
  const screen = useCoalescedFrame(latest, frozen);
  const parsed = useParsedScreen(screen?.text ?? '');
  const lines = useMemo(() => tailScreen(parsed, PREVIEW_HISTORY_ROWS), [parsed]);

  // The screen is read when the preview opens, whenever the agent's status moves, and when a held
  // selection lets go. The watch keeps it current while the preview is open and not held.
  const status = agent?.status;
  const live = !frozen;
  useEffect(() => {
    if (live) client.herdrRead(paneId);
  }, [client, paneId, status, live]);
  useHerdrScreenWatch(client, paneId, live);

  // A hibernated session has no live agent: its header names it, and its screen still reads.
  const header =
    agent !== undefined
      ? {
          title: `${agent.kind} · ${agent.paneId}`,
          note: HERDR_TONE_LABELS[herdrToneFor(agent.status)],
        }
      : sleeping !== undefined
        ? { title: sleepingName(sleeping), note: 'Ngủ đông' }
        : null;
  if (header === null) return <PreviewNotice text="Agent này không còn trong herdr." />;
  return (
    <>
      <PreviewHeader title={header.title} note={header.note} />
      {frozen && (
        <div className="px-2 pt-1">
          <ScreenFreezeChip />
        </div>
      )}
      {screen === undefined ? (
        <PreviewNotice text="Đang đọc màn hình…" />
      ) : (
        <PinnedScreenFrame>
          <ScreenView lines={lines} className="shrink-0 p-2" preRef={screenRef} />
        </PinnedScreenFrame>
      )}
    </>
  );
}

function SessionPreview({
  client,
  state,
  sessionId,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
}) {
  const session = state.sessions[sessionId];
  if (session === undefined) return <PreviewNotice text="Phiên đó không còn thuộc công ty nữa." />;
  if (!terminalPolicy(session.status).attach) {
    return <LogTailPreview state={state} sessionId={sessionId} code={session.code} />;
  }
  return (
    <>
      <PreviewHeader
        title={`${session.code} · ${companyRoleLabel(session.role)}`}
        note={sessionStatusLabel(session.status)}
      />
      <TerminalMirror
        client={client}
        sessionId={sessionId}
        runEpoch={session.runEpoch}
        terminal={state.terminals[sessionId]}
        rows={PREVIEW_HISTORY_ROWS}
      />
    </>
  );
}

/** A session with no live terminal shows the tail of its log instead. */
function LogTailPreview({
  state,
  sessionId,
  code,
}: {
  state: CompanyViewState;
  sessionId: string;
  code: string;
}) {
  const entries = logEntriesFor(state, sessionId, null).slice(-PREVIEW_LOG_ENTRIES);
  return (
    <>
      <PreviewHeader title={code} note="không có terminal · nhật ký" />
      {entries.length === 0 ? (
        <PreviewNotice text="Chưa có nhật ký." />
      ) : (
        <PinnedScreenFrame>
          <ScreenView
            lines={tailScreen(
              parseAnsiScreen(entries.map((entry) => entry.text).join('\n')),
              PREVIEW_HISTORY_ROWS,
            )}
            className="shrink-0 p-2"
          />
        </PinnedScreenFrame>
      )}
    </>
  );
}

function PreviewHeader({ title, note }: { title: string; note: string }) {
  return (
    <header className="flex shrink-0 items-baseline justify-between gap-2 px-2 py-1.5 text-2xs">
      <span className="min-w-0 truncate font-mono text-text">{title}</span>
      <span className="shrink-0 text-text-muted">{note}</span>
    </header>
  );
}

function PreviewNotice({ text }: { text: string }) {
  return <p className="p-2 text-2xs text-text-muted">{text}</p>;
}
