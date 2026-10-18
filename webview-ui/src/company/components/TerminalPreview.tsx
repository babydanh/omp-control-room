/**
 * TerminalPreview: the small floating terminal a hovered session or herdr row
 * opens. Only one preview is open at a time.
 *
 * The open state is decided by the pure reducer in terminalPreview.ts. This
 * provider runs its timers, listens for Escape, scroll and resize, and paints the
 * panel into the body above the drawer. Rows report pointer and keyboard focus
 * through previewTriggers, so the sidebar and the rail need no preview logic.
 */

import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { sleepingName } from '../agentSidebarView.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_SCREEN_POLL_MS } from '../constants.js';
import { HERDR_TONE_LABELS, herdrNeedsScreenPolling, herdrToneFor } from '../herdrView.js';
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
import { ScreenFrame } from './ScreenFrame.js';
import { ScreenView } from './ScreenView.js';
import { TerminalMirror } from './TerminalMirror.js';

/** Rows of screen a preview paints. */
const PREVIEW_SCREEN_ROWS = 14;
/** Log entries a preview reads when the session has no live terminal. */
const PREVIEW_LOG_ENTRIES = 8;
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
      if (event.key !== 'Escape') return;
      // Escape closes the preview only; the drawer and menus underneath keep theirs.
      event.stopPropagation();
      dispatch({ type: 'escape' });
    };
    const onScroll = (event: Event) => {
      const anchor = anchorRef.current;
      const scrolled = event.target;
      // A container that holds the row moves the row. Scrolling anywhere else does not.
      if (
        scrolled === document ||
        (scrolled instanceof Node && anchor !== null && scrolled.contains(anchor))
      ) {
        dispatch({ type: 'close' });
      }
    };
    const onResize = () => dispatch({ type: 'close' });
    const onPointerDown = () => dispatch({ type: 'close' });
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
}: {
  client: CompanyClient;
  state: CompanyViewState;
  target: PreviewTarget;
  anchor: PreviewRect;
  bounds: PreviewRect;
}) {
  const box = placePreview(anchor, bounds);
  return (
    <div
      aria-hidden="true"
      data-testid="terminal-preview"
      className="company-fade-in pointer-events-none fixed z-40 flex flex-col overflow-hidden rounded-(--company-radius-md) border border-hairline bg-raised"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      }}
    >
      {target.kind === 'herdr' ? (
        <HerdrPreview client={client} state={state} paneId={target.paneId} />
      ) : (
        <SessionPreview client={client} state={state} sessionId={target.sessionId} />
      )}
    </div>
  );
}

function HerdrPreview({
  client,
  state,
  paneId,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  paneId: string;
}) {
  const agent = state.herdr.agents.find((entry) => entry.paneId === paneId);
  const sleeping = state.herdr.sleeping.find((entry) => entry.paneId === paneId);
  const screen = state.herdr.screens[paneId];
  const lines = useMemo(
    () => tailScreen(parseAnsiScreen(screen?.text ?? ''), PREVIEW_SCREEN_ROWS),
    [screen?.text],
  );

  // Read on open and whenever the agent's status moves. As the drawer's screen tab does, poll
  // at HERDR_SCREEN_POLL_MS only while the agent works.
  const status = agent?.status;
  useEffect(() => {
    client.herdrRead(paneId);
  }, [client, paneId, status]);
  const polling = status !== undefined && herdrNeedsScreenPolling(status);
  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => client.herdrRead(paneId), HERDR_SCREEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, paneId, polling]);

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
      {screen === undefined ? (
        <PreviewNotice text="Đang đọc màn hình…" />
      ) : (
        <ScreenFrame>
          <ScreenView lines={lines} className="shrink-0 p-2" />
        </ScreenFrame>
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
        rows={PREVIEW_SCREEN_ROWS}
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
        <ScreenFrame>
          <ScreenView
            lines={tailScreen(
              parseAnsiScreen(entries.map((entry) => entry.text).join('\n')),
              PREVIEW_SCREEN_ROWS,
            )}
            className="shrink-0 p-2"
          />
        </ScreenFrame>
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
