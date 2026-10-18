/**
 * ScreenView: a terminal screen painted as coloured text. The herdr panel and the
 * terminal preview both paint through it, so a screen reads the same wherever it
 * appears.
 *
 * The segments come from terminalScreen.ts; this only turns them into spans. The
 * background and default text colour are the terminal theme's, so an uncoloured
 * screen looks the same as the terminal it mirrors.
 */

import type { CSSProperties } from 'react';
import { Fragment, useContext } from 'react';

import { TERMINAL_THEME } from '../../constants.js';
import type { ScreenLine, ScreenStyle } from '../terminalScreen.js';
import { WrapLinesContext } from '../wrapLines.js';

const SCREEN_COLORS: CSSProperties = {
  backgroundColor: TERMINAL_THEME.background,
  color: TERMINAL_THEME.foreground,
};

export interface ScreenViewProps {
  lines: readonly ScreenLine[];
  className?: string;
  testId?: string;
}

export function ScreenView({ lines, className = '', testId }: ScreenViewProps) {
  const wrap = useContext(WrapLinesContext);
  // Wrapped lines keep the screen whole at the drawer's width; unwrapped lines keep
  // their columns and scroll sideways inside the screen's own frame.
  const wrapClass = wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre';
  return (
    <pre
      data-testid={testId}
      data-wrap={wrap ? 'on' : 'off'}
      className={`m-0 min-w-0 max-w-full font-mono text-2xs leading-4 ${wrapClass} ${className}`}
      style={SCREEN_COLORS}
    >
      {lines.map((line, row) => (
        <Fragment key={row}>
          {line.map((segment, index) => (
            <span key={index} style={segmentStyle(segment.style)}>
              {segment.text}
            </span>
          ))}
          {row < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </pre>
  );
}

function segmentStyle(style: ScreenStyle): CSSProperties {
  const css: CSSProperties = {};
  // Inverse swaps the two colours, falling back to the theme's so it stays visible.
  const fg = style.inverse ? (style.bg ?? TERMINAL_THEME.background) : style.fg;
  const bg = style.inverse ? (style.fg ?? TERMINAL_THEME.foreground) : style.bg;
  if (fg !== undefined) css.color = fg;
  if (bg !== undefined) css.backgroundColor = bg;
  if (style.bold) css.fontWeight = 700;
  if (style.italic) css.fontStyle = 'italic';
  if (style.dim) css.opacity = 0.6;
  const decorations = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter((value) => value !== '')
    .join(' ');
  if (decorations !== '') css.textDecoration = decorations;
  return css;
}
