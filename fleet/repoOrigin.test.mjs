import assert from 'node:assert/strict';
import { test } from 'node:test';

import { repoFromOrigin } from './agent.mjs';

test('cloud repo identity is derived from origin without leaking URL credentials', () => {
  assert.equal(repoFromOrigin('git@github.com:pixel-agents-hq/pixel-agents.git'), 'pixel-agents-hq/pixel-agents');
  assert.equal(repoFromOrigin('https://token:secret@github.com/org/repo.git'), 'org/repo');
  assert.equal(repoFromOrigin('/data/home/not-a-remote'), '');
});
