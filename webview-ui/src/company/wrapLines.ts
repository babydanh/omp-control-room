/**
 * wrapLines: whether screen and log text wraps to the width it is given. The detail
 * drawer provides its persisted pref here, so every screen and log inside it follows
 * one choice without a prop threaded through each tab. Outside a drawer, text wraps.
 */

import { createContext } from 'react';

export const WrapLinesContext = createContext<boolean>(true);

/** Text blocks soft-wrap at the drawer's width, or stay whole and scroll sideways inside it. */
export function textWrapClass(wrap: boolean): string {
  return wrap
    ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
    : 'whitespace-pre overflow-x-auto';
}
