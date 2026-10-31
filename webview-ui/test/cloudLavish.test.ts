import { describe, expect, it } from 'vitest';

import { lavishOfSession } from '../src/company/fleet/cloudLavish.js';

const sessions = [
  { key: 'a', file: '/data/home/wt/backend-xep-san/.lavish/plan.html' },
  { key: 'b', file: '/data/home/wt/xep-san/web/.lavish/plan.html' },
  { key: 'c', file: '/data/home/wt/web-xep-san-2/.lavish/plan.html' },
  { key: 'd', file: '/data/home/Backend/.lavish/plan.html' },
  { key: 'e', file: '/data/home/wt/other/.lavish/plan.html' },
];

describe('lavishOfSession', () => {
  it('picks the Lavish files under the session worktree, single-repo or all-repos layout', () => {
    expect(lavishOfSession(sessions, 'xep-san').map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('does not pick a session whose slug only ends the same way', () => {
    expect(lavishOfSession(sessions, 'san')).toEqual([]);
    expect(lavishOfSession(sessions, 'xep-san-2').map((s) => s.key)).toEqual(['c']);
  });

  it('returns nothing when the machine has no Lavish', () => {
    expect(lavishOfSession(undefined, 'xep-san')).toEqual([]);
  });
});
