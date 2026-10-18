import { describe, expect, it } from 'vitest';

import {
  chatRoute,
  companyRoute,
  formatSessionSize,
  formatUpdatedAt,
  planComposerCommand,
  resumeListView,
  resumeRowTitle,
  sendTargetLabel,
  terminalLine,
} from '../src/company/composerRouting.js';
import { session } from './companyFixtures.js';

const IDLE_WORKER = session({
  id: 'worker-1',
  code: 'PA-S0002',
  name: 'Worker two',
  role: 'worker',
  status: 'idle',
});

describe('Enter sends a chat prompt to the selected session', () => {
  it('opens a new omp chat when nothing is selected', () => {
    expect(chatRoute(null)).toEqual({ mode: 'chat', delivery: 'prompt', targetSessionId: null });
  });

  it('prompts an idle session', () => {
    expect(chatRoute(IDLE_WORKER)).toEqual({
      mode: 'chat',
      delivery: 'prompt',
      targetSessionId: 'worker-1',
    });
  });

  it.each(['busy', 'running', 'starting'])('steers a session that is %s', (status) => {
    expect(chatRoute({ id: 'worker-1', role: 'worker', status })).toEqual({
      mode: 'chat',
      delivery: 'steer',
      targetSessionId: 'worker-1',
    });
  });

  it('is never a company prompt, whatever the selected session is', () => {
    for (const role of ['chat', 'worker'] as const) {
      for (const status of ['idle', 'busy']) {
        expect(chatRoute({ id: 's', role, status }).mode).toBe('chat');
      }
    }
    expect(chatRoute(null).mode).toBe('chat');
  });
});

describe('Ctrl/Cmd+Shift+Enter and the company button go to the Company workflow', () => {
  it('targets a selected Company session', () => {
    expect(companyRoute(IDLE_WORKER)).toEqual({
      mode: 'company',
      delivery: 'prompt',
      targetSessionId: 'worker-1',
    });
  });

  it('never targets a plain omp chat', () => {
    const chat = session({ id: 'chat-1', role: 'chat' });
    expect(companyRoute(chat)).toEqual({
      mode: 'company',
      delivery: 'prompt',
      targetSessionId: null,
    });
  });

  it('goes to the Company workflow with no target when nothing is selected', () => {
    expect(companyRoute(null)).toEqual({
      mode: 'company',
      delivery: 'prompt',
      targetSessionId: null,
    });
  });

  it('is always a company prompt', () => {
    const chat = session({ id: 'chat-1', role: 'chat' });
    for (const target of [null, IDLE_WORKER, chat]) {
      expect(companyRoute(target).mode).toBe('company');
    }
  });
});

describe('the line above the box says where a plain send goes', () => {
  it('names a new omp chat when no session is selected', () => {
    expect(sendTargetLabel(null)).toBe('Gửi tới: phiên omp mới');
  });

  it('names the selected session, its code, its name and its role', () => {
    expect(sendTargetLabel(IDLE_WORKER)).toBe('Gửi tới: PA-S0002 · Worker two · Nhân viên');
  });

  it('names a plain omp chat with the chat role label', () => {
    expect(sendTargetLabel(session({ code: 'PA-S0003', name: 'Chat one', role: 'chat' }))).toBe(
      'Gửi tới: PA-S0003 · Chat one · Phiên chat',
    );
  });

  it('names the herdr agent when one is the target, even with a session selected', () => {
    expect(sendTargetLabel(null, { kind: 'omp', paneId: 'wD:p1' })).toBe(
      'Gửi tới: omp · wD:p1 (herdr)',
    );
    expect(sendTargetLabel(IDLE_WORKER, { kind: 'omp', paneId: 'wD:p1' })).toBe(
      'Gửi tới: omp · wD:p1 (herdr)',
    );
  });
});

describe('the composer runs its own slash commands and passes the rest on', () => {
  it('turns /new into a new-chat command, with or without a trailing space', () => {
    expect(planComposerCommand('/new')).toEqual({ kind: 'new' });
    expect(planComposerCommand('/new ')).toEqual({ kind: 'new' });
  });

  it('turns /resume into a resume command, whatever follows it', () => {
    expect(planComposerCommand('/resume')).toEqual({ kind: 'resume' });
    expect(planComposerCommand('/resume abc')).toEqual({ kind: 'resume' });
  });

  it('types every other OMP command into the selected session, unchanged', () => {
    expect(planComposerCommand('/model')).toEqual({ kind: 'prompt' });
    expect(planComposerCommand('/compact focus on tests')).toEqual({ kind: 'prompt' });
  });

  it('keeps plain text, unknown commands and /new with arguments on the prompt path', () => {
    expect(planComposerCommand('build the standings page')).toEqual({ kind: 'prompt' });
    expect(planComposerCommand('/unknown-command')).toEqual({ kind: 'prompt' });
    expect(planComposerCommand('/new extra')).toEqual({ kind: 'prompt' });
    expect(planComposerCommand('/')).toEqual({ kind: 'prompt' });
  });
});

describe('a typed line becomes the bytes the terminal reads', () => {
  it('adds Enter to a single line, and drops trailing blanks', () => {
    expect(terminalLine('/compact')).toBe('/compact\r');
    expect(terminalLine('/switch gpt   \n')).toBe('/switch gpt\r');
  });

  it('sends nothing for blank text', () => {
    expect(terminalLine('')).toBeNull();
    expect(terminalLine('   \n ')).toBeNull();
  });

  it('pastes several lines as one bracketed paste, then Enter', () => {
    expect(terminalLine('first\nsecond')).toBe('\u001b[200~first\nsecond\u001b[201~\r');
    expect(terminalLine('first\r\nsecond')).toBe('\u001b[200~first\nsecond\u001b[201~\r');
  });
});

describe('the /resume picker state', () => {
  const saved = { file: 'D:/omp/a.jsonl', updatedAt: '2026-10-02T10:00:00.000Z', sizeBytes: 1 };
  const answer = { requestId: 'req-1', folder: 'D:/omp', sessions: [saved] };

  it('is loading while its request is unanswered', () => {
    expect(resumeListView('req-1', null, undefined)).toEqual({ kind: 'loading' });
  });

  it('is loading when the verdict is ok but the list has not arrived', () => {
    expect(resumeListView('req-1', null, { requestId: 'req-1', ok: true })).toEqual({
      kind: 'loading',
    });
  });

  it('lists the answer to its own request', () => {
    expect(resumeListView('req-1', answer, undefined)).toEqual({
      kind: 'ready',
      entries: [saved],
    });
  });

  it('does not list an answer to another request', () => {
    expect(resumeListView('req-2', answer, undefined)).toEqual({ kind: 'loading' });
  });

  it('shows the refusal message of its request', () => {
    expect(
      resumeListView('req-1', null, {
        requestId: 'req-1',
        ok: false,
        errorCode: 'workspace_missing',
        message: 'Không mở được thư mục.',
      }),
    ).toEqual({ kind: 'failed', message: 'Không mở được thư mục.' });
  });

  it('falls back to the error code, then to a fixed notice', () => {
    expect(
      resumeListView('req-1', null, {
        requestId: 'req-1',
        ok: false,
        errorCode: 'workspace_missing',
      }),
    ).toEqual({ kind: 'failed', message: 'workspace_missing' });
    expect(resumeListView('req-1', null, { requestId: 'req-1', ok: false })).toEqual({
      kind: 'failed',
      message: 'Chưa tải được danh sách phiên.',
    });
  });
});

describe('a saved session row', () => {
  it('is titled by its title, trimmed', () => {
    expect(resumeRowTitle({ file: 'D:/omp/a.jsonl', title: '  Bảng xếp hạng  ' })).toBe(
      'Bảng xếp hạng',
    );
  });

  it('falls back to the file name, whichever separator the path uses', () => {
    expect(resumeRowTitle({ file: 'D:/omp/a.jsonl', title: '   ' })).toBe('a.jsonl');
    expect(resumeRowTitle({ file: 'C:\\Users\\me\\.omp\\b.jsonl' })).toBe('b.jsonl');
  });

  it('shows its size in KB below a megabyte and in MB from one megabyte up', () => {
    expect(formatSessionSize(0)).toBe('0 KB');
    expect(formatSessionSize(2048)).toBe('2 KB');
    expect(formatSessionSize(1023 * 1024)).toBe('1023 KB');
    expect(formatSessionSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSessionSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('shows its update time in the Vietnamese locale, and an unreadable stamp as sent', () => {
    const updatedAt = '2026-10-02T10:00:00.000Z';
    expect(formatUpdatedAt(updatedAt)).toBe(new Date(updatedAt).toLocaleString('vi-VN'));
    expect(formatUpdatedAt('không phải ngày')).toBe('không phải ngày');
  });
});
