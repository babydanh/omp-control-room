import { describe, expect, it } from 'vitest';

import { defaultDrawerTab, shortModelName } from '../src/company/drawerView.js';

describe('defaultDrawerTab', () => {
  it.each(['starting', 'idle', 'busy', 'waiting_input'])(
    'opens a live session (%s) on its terminal',
    (status) => {
      expect(defaultDrawerTab(status)).toBe('terminal');
    },
  );

  it.each([
    'parked',
    'pausing',
    'paused',
    'stopping',
    'stopped',
    'crashed',
    'archived',
    'some-unknown-status',
  ])('opens a session that is not live (%s) on its log', (status) => {
    expect(defaultDrawerTab(status)).toBe('log');
  });
});

describe('shortModelName', () => {
  it('drops the provider from a provider-qualified model', () => {
    expect(shortModelName('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });

  it('keeps a bare model name and trims stray spaces', () => {
    expect(shortModelName('  gpt-5  ')).toBe('gpt-5');
  });

  it('keeps only the last segment when a model name has several slashes', () => {
    expect(shortModelName('openrouter/anthropic/claude-opus')).toBe('claude-opus');
  });

  it('returns nothing for a blank model', () => {
    expect(shortModelName('   ')).toBe('');
  });
});
