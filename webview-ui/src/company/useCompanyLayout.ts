/**
 * useCompanyLayout: split pane on a desktop, tabs on a narrow window.
 *
 * The board is a peer of the office, not a replacement for it: on a wide window
 * both are on screen so a task's card and the character doing it are visible at
 * once. Below COMPANY_SPLIT_MIN_WIDTH_PX there is not enough room for both, so
 * the same two surfaces become tabs and the composer stays put underneath,
 * because a prompt must always be typeable.
 */

import { useEffect, useState } from 'react';

import { COMPANY_SPLIT_MIN_WIDTH_PX } from './constants.js';

export type CompanyLayoutMode = 'split' | 'tabs';

export function useCompanyLayout(): CompanyLayoutMode {
  const [mode, setMode] = useState<CompanyLayoutMode>(() =>
    typeof window === 'undefined' || window.innerWidth >= COMPANY_SPLIT_MIN_WIDTH_PX
      ? 'split'
      : 'tabs',
  );

  useEffect(() => {
    const update = () =>
      setMode(window.innerWidth >= COMPANY_SPLIT_MIN_WIDTH_PX ? 'split' : 'tabs');
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return mode;
}
