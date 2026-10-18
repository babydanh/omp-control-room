/**
 * Reads one property of a parsed JSON value. Anything that is not an object, or lacks the
 * property, reads as `undefined`, so each field is checked where it is used.
 */
export function jsonField(parent: unknown, key: string): unknown {
  if (parent === null || typeof parent !== 'object' || !(key in parent)) return undefined;
  return Reflect.get(parent, key);
}
