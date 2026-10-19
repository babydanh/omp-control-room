import { describe, expect, it } from 'vitest';

import { isReplayableClientMessage } from '../../core/src/messageDelivery.js';

describe('isReplayableClientMessage', () => {
  it('lets the usage page reads wait out a dropped socket', () => {
    expect(isReplayableClientMessage({ type: 'usageLimitsRequest' })).toBe(true);
    expect(isReplayableClientMessage({ type: 'usageStatsRequest' })).toBe(true);
    expect(isReplayableClientMessage({ type: 'usageHistoryRequest' })).toBe(true);
  });

  it('still refuses to replay an action', () => {
    expect(isReplayableClientMessage({ type: 'herdrRename' })).toBe(false);
  });
});
