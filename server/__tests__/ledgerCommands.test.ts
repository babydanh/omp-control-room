import { describe, expect, it } from 'vitest';

import type { LedgerWorktree } from '../../core/src/messages.js';
import { fileDiff, sendMessage } from '../src/ledger/commands.js';
import {
  LEDGER_DEV_NULL,
  LEDGER_DIFF_MAX_BYTES,
  LEDGER_DIFF_TIMEOUT_MS,
  LEDGER_REASON_BAD_SESSION,
  LEDGER_REASON_DIFF_EMPTY,
  LEDGER_REASON_DIFF_FAILED,
  LEDGER_REASON_DIFF_TIMEOUT,
  LEDGER_REASON_EMPTY_TEXT,
  LEDGER_REASON_PATH_INVALID,
  LEDGER_REASON_SEND_FAILED,
  LEDGER_REASON_SEND_TIMEOUT,
  LEDGER_REASON_TEXT_NUL,
  LEDGER_REASON_TEXT_TOO_LONG,
  LEDGER_REASON_WORKTREE_UNKNOWN,
  LEDGER_SEND_OUTPUT_MAX_BYTES,
  LEDGER_SEND_REASON_MAX,
  LEDGER_SEND_TEXT_MAX,
  LEDGER_SEND_TIMEOUT_MS,
} from '../src/ledger/constants.js';
import { FakeGitRunner, fakeScript } from './ledgerFixtures.js';

const SESSION_ID = 'session-0123456789abcdef';
const WORKTREE = 'C:/Repo-wt/feat';

const KNOWN: Pick<LedgerWorktree, 'path' | 'dirtyFiles'>[] = [
  {
    path: WORKTREE,
    dirtyFiles: [
      { status: '??', path: 'new.ts' },
      { status: 'M', path: 'src/a.ts' },
    ],
  },
];

describe('sendMessage: validation', () => {
  it.each([
    ['a malformed session id', 'bad id!', 'hi', LEDGER_REASON_BAD_SESSION],
    ['a session id longer than 128 characters', 'x'.repeat(129), 'hi', LEDGER_REASON_BAD_SESSION],
    ['blank text', SESSION_ID, '   ', LEDGER_REASON_EMPTY_TEXT],
    ['text with a NUL byte', SESSION_ID, 'a\u0000b', LEDGER_REASON_TEXT_NUL],
    [
      'text over the length cap',
      SESSION_ID,
      'x'.repeat(LEDGER_SEND_TEXT_MAX + 1),
      LEDGER_REASON_TEXT_TOO_LONG,
    ],
  ])('refuses %s without running who.py', async (_label, sessionId, text, reason) => {
    const who = fakeScript({});
    expect(await sendMessage(who.run, sessionId, text)).toEqual({ ok: false, reason });
    expect(who.calls).toHaveLength(0);
  });

  it('accepts text exactly at the length cap', async () => {
    const who = fakeScript({});
    const outcome = await sendMessage(who.run, SESSION_ID, 'x'.repeat(LEDGER_SEND_TEXT_MAX));
    expect(outcome.ok).toBe(true);
    expect(who.calls).toHaveLength(1);
  });
});

describe('sendMessage: who.py send', () => {
  it('runs who.py send with the exact argv, trimmed text, and no --notify', async () => {
    const who = fakeScript({ stdout: 'Đã gửi tới …89abcdef\n' });
    await sendMessage(who.run, SESSION_ID, '  hi  ');

    expect(who.calls).toHaveLength(1);
    expect(who.calls[0].argv).toEqual(['send', SESSION_ID, 'hi']);
    expect(who.calls[0].argv).not.toContain('--notify');
    expect(who.calls[0].options).toEqual({
      timeoutMs: LEDGER_SEND_TIMEOUT_MS,
      okCodes: [0],
      maxBytes: LEDGER_SEND_OUTPUT_MAX_BYTES,
    });
  });

  it('reports the last eight characters of the session id as delivered', async () => {
    const who = fakeScript({ stdout: '' });
    expect(await sendMessage(who.run, SESSION_ID, 'hi')).toEqual({
      ok: true,
      delivered: ['89abcdef'],
    });
  });

  it('reports a timeout as unknown delivery, not as a failure', async () => {
    const who = fakeScript({ timedOut: true });
    expect(await sendMessage(who.run, SESSION_ID, 'hi')).toEqual({
      ok: false,
      reason: LEDGER_REASON_SEND_TIMEOUT,
    });
  });

  it('passes the trimmed stderr of a failed send through as the reason', async () => {
    const who = fakeScript({ code: 1, stderr: '  Session không sẵn sàng \n' });
    expect(await sendMessage(who.run, SESSION_ID, 'hi')).toEqual({
      ok: false,
      reason: 'Session không sẵn sàng',
    });
  });

  it('caps a long stderr reason', async () => {
    const who = fakeScript({ code: 1, stderr: 'e'.repeat(500) });
    const outcome = await sendMessage(who.run, SESSION_ID, 'hi');
    expect(outcome.reason).toHaveLength(LEDGER_SEND_REASON_MAX);
  });

  it('falls back to the generic failure reason when stderr is empty', async () => {
    const who = fakeScript({ code: 1, stderr: '   ' });
    expect(await sendMessage(who.run, SESSION_ID, 'hi')).toEqual({
      ok: false,
      reason: LEDGER_REASON_SEND_FAILED,
    });
  });
});

describe('fileDiff: refusals', () => {
  it('refuses a worktree the latest view does not list', async () => {
    const git = new FakeGitRunner(() => ({}));
    expect(await fileDiff(git, 'C:/Elsewhere', 'a.ts', KNOWN)).toEqual({
      ok: false,
      diff: '',
      truncated: false,
      reason: LEDGER_REASON_WORKTREE_UNKNOWN,
    });
    expect(git.calls).toHaveLength(0);
  });

  it.each([
    ['an empty path', ''],
    ['a parent-relative path', '../x'],
    ['a parent segment inside the path', 'src/../x'],
    ['a POSIX absolute path', '/abs'],
    ['a UNC path', '\\\\server\\share'],
    ['a drive-letter path', 'C:/x'],
    ['a path with a NUL byte', 'a\u0000b'],
    ['a path over the length cap', 'x'.repeat(1025)],
  ])('refuses %s without running git', async (_label, path) => {
    const git = new FakeGitRunner(() => ({}));
    const outcome = await fileDiff(git, WORKTREE, path, KNOWN);
    expect(outcome).toMatchObject({ ok: false, reason: LEDGER_REASON_PATH_INVALID });
    expect(git.calls).toHaveLength(0);
  });

  it('matches the worktree case-insensitively and ignores a trailing slash', async () => {
    const git = new FakeGitRunner(() => ({ stdout: 'diff' }));
    await fileDiff(git, 'c:/repo-wt/feat/', 'src/a.ts', KNOWN);
    expect(git.calls[0].cwd).toBe(WORKTREE);
  });
});

describe('fileDiff: git argv', () => {
  it('diffs an untracked file against /dev/null, accepting exit 1', async () => {
    const git = new FakeGitRunner(() => ({ code: 1, stdout: '+++ new.ts\n' }));
    const outcome = await fileDiff(git, WORKTREE, 'new.ts', KNOWN);

    expect(git.calls[0].args).toEqual([
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--',
      LEDGER_DEV_NULL,
      'new.ts',
    ]);
    expect(git.calls[0].options.okCodes).toEqual([0, 1]);
    expect(outcome).toEqual({ ok: true, diff: '+++ new.ts\n', truncated: false });
  });

  it('diffs a tracked file against HEAD, accepting only exit 0', async () => {
    const git = new FakeGitRunner(() => ({ stdout: '-old\n+new\n' }));
    await fileDiff(git, WORKTREE, 'src/a.ts', KNOWN);

    expect(git.calls[0].args).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      'HEAD',
      '--',
      'src/a.ts',
    ]);
    expect(git.calls[0].options).toEqual({
      timeoutMs: LEDGER_DIFF_TIMEOUT_MS,
      okCodes: [0],
      maxBytes: LEDGER_DIFF_MAX_BYTES,
    });
  });

  it('reports an empty diff with the no-changes reason', async () => {
    const git = new FakeGitRunner(() => ({ stdout: '' }));
    expect(await fileDiff(git, WORKTREE, 'src/a.ts', KNOWN)).toEqual({
      ok: true,
      diff: '',
      truncated: false,
      reason: LEDGER_REASON_DIFF_EMPTY,
    });
  });

  it('passes a truncated diff through with its flag', async () => {
    const git = new FakeGitRunner(() => ({ stdout: '+x\n', truncated: true }));
    expect(await fileDiff(git, WORKTREE, 'src/a.ts', KNOWN)).toEqual({
      ok: true,
      diff: '+x\n',
      truncated: true,
    });
  });

  it('reports a timeout and a git failure with their own reasons', async () => {
    const timed = new FakeGitRunner(() => ({ timedOut: true }));
    expect(await fileDiff(timed, WORKTREE, 'src/a.ts', KNOWN)).toMatchObject({
      ok: false,
      reason: LEDGER_REASON_DIFF_TIMEOUT,
    });

    const failed = new FakeGitRunner(() => ({ code: 128, stderr: 'fatal' }));
    expect(await fileDiff(failed, WORKTREE, 'src/a.ts', KNOWN)).toMatchObject({
      ok: false,
      reason: LEDGER_REASON_DIFF_FAILED,
    });
  });
});
