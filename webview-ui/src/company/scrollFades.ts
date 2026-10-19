/**
 * scrollFades: the board's scroll areas draw no scrollbar, so an edge that has more
 * content beyond it fades out instead, and an edge with nothing beyond stays solid. Which
 * edges fade is pure data, tested without a DOM. The controller at the bottom tracks the
 * board's scroll areas and sets the two flags that index.css draws the fade from.
 *
 * Only registered areas are tracked. The board is scanned once at start; after that each board
 * root reports its structural changes (childList, subtree), and only the added nodes' own
 * subtrees are examined. A body observer (direct children only) notices portalled board roots
 * arriving or leaving. Trade-off: an overflow change with no insertion, removal or resize (a
 * class, style or hidden toggle, a viewport breakpoint, text that changes in place) is not
 * noticed until that area next scrolls or resizes; watching attributes and text across the board
 * would bring back the rescans this design removes.
 */

/** How far from an edge still counts as on it, in CSS pixels, for sub-pixel rounding. */
const EDGE_TOLERANCE_PX = 1;

/** A scroll area's position and size along its vertical axis. */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Whether content lies beyond the top edge and the bottom edge of a scroll area. */
export interface ScrollFadeEdges {
  top: boolean;
  bottom: boolean;
}

/** The edges with content beyond them: the top once scrolled down, the bottom while more lies below. */
export function scrollFadeEdges(geometry: ScrollGeometry): ScrollFadeEdges {
  const overflow = geometry.scrollHeight - geometry.clientHeight;
  if (overflow <= EDGE_TOLERANCE_PX) return { top: false, bottom: false };
  return {
    top: geometry.scrollTop > EDGE_TOLERANCE_PX,
    bottom: geometry.scrollTop < overflow - EDGE_TOLERANCE_PX,
  };
}

/** The attributes index.css keys the edge fade on. */
const FADE_TOP = 'data-fade-top';
const FADE_BOTTOM = 'data-fade-bottom';
/** Every element the board draws, portalled dialogs included, sits under one of these roots. */
const BOARD_ROOT = '.company-ui';
/** Terminal output churns many times a second; the viewport's own scroll events cover it. */
const TERMINAL = '.xterm';

/** Whether an element's computed style lets it scroll vertically. */
function scrollsVertically(element: HTMLElement): boolean {
  const overflow = getComputedStyle(element).overflowY;
  return overflow === 'auto' || overflow === 'scroll';
}

/**
 * Keeps the edge flags of the board's scroll areas current. An area is registered once it is
 * found to scroll; it then gets its own scroll listener and ResizeObserver, and a structural
 * change inside it re-reads it. Returns the function that stops the controller, releases every
 * area and clears its flags.
 */
export function startScrollFades(): () => void {
  const areas = new Set<HTMLElement>();
  const boards = new Map<Element, MutationObserver>();
  const addedNodes = new Set<Element>();
  const changedParents = new Set<Element>();
  let frame = 0;

  const resizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) refresh(entry.target);
    }
  });
  const onScroll = (event: Event): void => {
    if (event.currentTarget instanceof HTMLElement) refresh(event.currentTarget);
  };

  function release(element: HTMLElement): void {
    element.removeAttribute(FADE_TOP);
    element.removeAttribute(FADE_BOTTOM);
    if (!areas.delete(element)) return;
    resizes.unobserve(element);
    element.removeEventListener('scroll', onScroll);
  }

  function refresh(element: HTMLElement): void {
    // A short area reads zero overflow without any style lookup; only a long one is checked.
    if (element.scrollHeight - element.clientHeight <= EDGE_TOLERANCE_PX) {
      release(element);
      return;
    }
    if (!scrollsVertically(element)) {
      release(element);
      return;
    }
    if (!areas.has(element)) {
      areas.add(element);
      resizes.observe(element);
      element.addEventListener('scroll', onScroll, { passive: true });
    }
    const edges = scrollFadeEdges({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    element.toggleAttribute(FADE_TOP, edges.top);
    element.toggleAttribute(FADE_BOTTOM, edges.bottom);
  }

  /** Re-reads the areas that hold a changed parent: the parent up to its board root. */
  function refreshAncestors(parent: Element, seen: Set<Element>): void {
    const board = parent.closest(BOARD_ROOT);
    if (board === null) return;
    let node: Element | null = parent;
    while (node !== null && !seen.has(node)) {
      seen.add(node);
      if (node instanceof HTMLElement) refresh(node);
      if (node === board) return;
      node = node.parentElement;
    }
  }

  /** Registers or releases the areas in one added subtree, the node itself included. */
  function examine(node: Element): void {
    if (node instanceof HTMLElement) refresh(node);
    node.querySelectorAll('*').forEach((descendant) => {
      if (descendant instanceof HTMLElement) refresh(descendant);
    });
  }

  function flush(): void {
    frame = 0;
    for (const [board, observer] of boards) {
      if (board.isConnected) continue;
      observer.disconnect();
      boards.delete(board);
    }
    for (const node of addedNodes) {
      if (node.isConnected) examine(node);
    }
    addedNodes.clear();
    const seen = new Set<Element>();
    for (const parent of changedParents) {
      if (parent.isConnected) refreshAncestors(parent, seen);
    }
    changedParents.clear();
    for (const area of areas) {
      if (!area.isConnected) release(area);
    }
  }

  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(flush);
  }

  /** Records a board root's structural changes; terminal output is skipped. */
  function onStructure(records: MutationRecord[]): void {
    for (const record of records) {
      const parent = record.target;
      if (!(parent instanceof Element) || parent.closest(TERMINAL) !== null) continue;
      changedParents.add(parent);
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) addedNodes.add(node);
      });
    }
    schedule();
  }

  function watchBoard(board: Element): void {
    if (boards.has(board)) return;
    const observer = new MutationObserver(onStructure);
    observer.observe(board, { childList: true, subtree: true });
    boards.set(board, observer);
    addedNodes.add(board);
    schedule();
  }

  function watchBoardsIn(node: Element): void {
    if (node.matches(BOARD_ROOT)) watchBoard(node);
    node.querySelectorAll(BOARD_ROOT).forEach((board) => watchBoard(board));
  }

  // Dialogs and previews portal their board roots directly onto the body. Only direct children
  // are observed, so this sees a root arrive or leave, never the markup inside it.
  const portals = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) watchBoardsIn(node);
      });
    }
    schedule();
  });
  const onWindowResize = (): void => {
    for (const area of areas) refresh(area);
  };

  // The one full scan: each board already on the page is walked once, here.
  document.querySelectorAll(BOARD_ROOT).forEach((board) => watchBoard(board));
  portals.observe(document.body, { childList: true });
  window.addEventListener('resize', onWindowResize);

  return () => {
    portals.disconnect();
    for (const observer of boards.values()) observer.disconnect();
    boards.clear();
    resizes.disconnect();
    window.removeEventListener('resize', onWindowResize);
    cancelAnimationFrame(frame);
    frame = 0;
    addedNodes.clear();
    changedParents.clear();
    for (const area of areas) release(area);
  };
}
