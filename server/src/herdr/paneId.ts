/** Pane ids look like `wA:p2`; this keeps arbitrary client strings out of herdr targets. */
const PANE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/;

export function isHerdrPaneId(value: unknown): value is string {
  return typeof value === 'string' && PANE_ID_PATTERN.test(value);
}
