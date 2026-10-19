/**
 * scrollFades: the board's scroll areas draw no scrollbar, so an edge that has more
 * content beyond it fades out instead, and an edge with nothing beyond stays solid. Which
 * edges fade is pure data, tested without a DOM. The controller at the bottom reads the
 * live areas and sets the two flags that index.css draws the fade from.
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
/** Every element the board draws, portalled dialogs included; the scan reads only what can scroll. */
const BOARD_ELEMENTS = '.company-ui *';

/** Whether an element's computed style lets it scroll vertically. */
function scrollsVertically(element: HTMLElement): boolean {
  const overflow = getComputedStyle(element).overflowY;
  return overflow === 'auto' || overflow === 'scroll';
}

/**
 * Keeps the edge flags of every board scroll area current. An area is re-read when it
 * scrolls, when it resizes, and after the board's markup or classes change. The terminal's
 * own output is skipped: its viewport follows the output with a scroll event of its own.
 * Returns the function that stops the controller and clears its flags.
 */
export function startScrollFades(): () => void {
  const observed = new Set<HTMLElement>();
  let frame = 0;

  function release(element: HTMLElement): void {
    element.removeAttribute(FADE_TOP);
    element.removeAttribute(FADE_BOTTOM);
    if (observed.delete(element)) resizes.unobserve(element);
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
    if (!observed.has(element)) {
      observed.add(element);
      resizes.observe(element);
    }
    const edges = scrollFadeEdges({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    element.toggleAttribute(FADE_TOP, edges.top);
    element.toggleAttribute(FADE_BOTTOM, edges.bottom);
  }

  function scan(): void {
    frame = 0;
    for (const element of observed) {
      if (!element.isConnected) release(element);
    }
    document.querySelectorAll(BOARD_ELEMENTS).forEach((node) => {
      if (node instanceof HTMLElement) refresh(node);
    });
  }

  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(scan);
  }

  const resizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) refresh(entry.target);
    }
  });
  const mutations = new MutationObserver((records) => {
    // A terminal streams output many times a second; its scroll events cover it, so it is not rescanned.
    const relevant = records.some(
      (record) => !(record.target instanceof Element && record.target.closest('.xterm') !== null),
    );
    if (relevant) schedule();
  });
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('.company-ui') !== null) refresh(target);
  };

  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'data-collapsed'],
  });
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  schedule();

  return () => {
    mutations.disconnect();
    resizes.disconnect();
    document.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', schedule);
    cancelAnimationFrame(frame);
    for (const element of observed) release(element);
  };
}
