import { describe, expect, it } from 'vitest';

import {
  isAllowedOmpProvider,
  mapAgyModels,
  mapClaudeStatus,
  maskAccountEmail,
  OMP_CREDENTIALS_SQL,
} from '../src/library/accounts.js';

describe('library account mapping', () => {
  it('masks account email addresses while retaining the domain', () => {
    expect(maskAccountEmail('abigail@example.com')).toBe('ab***@example.com');
    expect(maskAccountEmail('a@example.com')).toBe('a***@example.com');
    expect(maskAccountEmail(undefined)).toBeUndefined();
    expect(maskAccountEmail('not-an-email')).toBeUndefined();
  });

  it('maps Claude JSON account fields and masks the email', () => {
    expect(mapClaudeStatus(JSON.stringify({
      loggedIn: true,
      authMethod: 'oauth',
      subscriptionType: 'pro',
      orgName: 'Example Org',
      email: 'abigail@example.com',
    }))).toEqual({
      loggedIn: true,
      authMethod: 'oauth',
      subscriptionType: 'pro',
      orgName: 'Example Org',
      email: 'ab***@example.com',
    });
    expect(mapClaudeStatus('{"loggedIn":false}')).toEqual({
      loggedIn: false,
      authMethod: undefined,
      subscriptionType: undefined,
      orgName: undefined,
      email: undefined,
    });
  });

  it('maps agy model output to an available model count', () => {
    expect(mapAgyModels('MODEL\n--------\nclaude-sonnet\ngemini-pro\n')).toBe(2);
    expect(mapAgyModels('Model\n-----\n')).toBe(0);
  });

  it('selects only approved OMP credential metadata', () => {
    expect(OMP_CREDENTIALS_SQL).toMatch(/SELECT c\.provider, c\.credential_type, c\.disabled_cause, c\.updated_at/);
    expect(OMP_CREDENTIALS_SQL).toContain('b.credential_id = c.id');
    expect(OMP_CREDENTIALS_SQL).not.toMatch(/\bdata\b|identity_key/i);
  });

  it('accepts only listed provider identifiers with safe characters', () => {
    const configured = new Set(['open-ai-2']);
    expect(isAllowedOmpProvider('open-ai-2', configured)).toBe(true);
    expect(isAllowedOmpProvider('other', configured)).toBe(false);
    expect(isAllowedOmpProvider('open_ai', configured)).toBe(false);
    expect(isAllowedOmpProvider('open-ai;', configured)).toBe(false);
    expect(isAllowedOmpProvider('OpenAI', configured)).toBe(false);
  });
});
