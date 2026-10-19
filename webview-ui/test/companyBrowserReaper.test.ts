import { describe, expect, it } from 'vitest';

import { TRANSPORT_STATE_CONNECTED } from '../../core/src/constants.js';
import type { BrowserReaperBrowser, BrowserReaperStatusMessage } from '../../core/src/messages.js';
import { browserReaperReapNow, isCompanyServerMessage } from '../src/company/companyMessages.js';
import { applyCompanyMessage } from '../src/company/companyState.js';
import {
  BROWSER_SECTION_TITLE,
  type BrowserSectionView,
  statusPillView,
  type StatusRow,
} from '../src/company/statusPillView.js';
import { stateFrom } from './companyFixtures.js';

const MIN = 60_000;
const IDLE: BrowserReaperBrowser = {
  projectDir: 'V:/work/project-a',
  pages: 0,
  idleSince: '2026-01-01T10:00:00.000Z',
  uptimeMs: 25 * MIN,
};
const BUSY: BrowserReaperBrowser = {
  projectDir: 'V:/work/project-b',
  pages: 2,
  idleSince: null,
  uptimeMs: 3 * MIN + 30_000,
};

function report(overrides: Partial<BrowserReaperStatusMessage> = {}): BrowserReaperStatusMessage {
  return {
    type: 'browserReaperStatus',
    enabled: true,
    browsers: [],
    reapedCount: 0,
    freedMb: 0,
    ...overrides,
  };
}

/** The browsers section the pill draws, after the server's report went through the reducer. */
function sectionFor(message: BrowserReaperStatusMessage | null): BrowserSectionView {
  const state = message === null ? stateFrom() : applyCompanyMessage(stateFrom(), message).state;
  return statusPillView(TRANSPORT_STATE_CONNECTED, state).browsers;
}

function valueOf(rows: readonly StatusRow[], label: string): string | undefined {
  return rows.find((row) => row.label === label)?.value;
}

describe('browser reaper section', () => {
  it('uses the section heading the popover draws', () => {
    expect(BROWSER_SECTION_TITLE).toBe('Trình duyệt ẩn của omp');
  });

  it('reports each browser, its pages, when an idle one is reaped, and the total freed', () => {
    const view = sectionFor(report({ browsers: [IDLE, BUSY], reapedCount: 1, freedMb: 300 }));

    expect(valueOf(view.rows, 'Đang chạy')).toBe('2 trình duyệt');
    expect(valueOf(view.rows, 'project-a')).toMatch(
      /^0 trang · chạy 25 phút · rảnh từ \d{2}:\d{2} · dọn sau 10 phút rảnh$/,
    );
    expect(valueOf(view.rows, 'project-b')).toBe('2 trang · chạy 3 phút');
    expect(valueOf(view.rows, 'Đã giải phóng')).toBe('300 MB · 1 trình duyệt');
  });

  it('says the reaper is off when it is disabled', () => {
    const view = sectionFor(report({ enabled: false }));

    expect(view.rows).toEqual([{ label: 'Trạng thái', value: 'Tắt', attention: false }]);
    expect(view.reapable).toBe(false);
  });

  it('reads an unreported reaper as unknown, not as no browsers', () => {
    const view = sectionFor(null);

    expect(view.rows).toEqual([
      { label: 'Trạng thái', value: 'chưa có số liệu', attention: false },
    ]);
    expect(view.reapable).toBe(false);
  });

  it('offers Dọn ngay only while some browser has no open page', () => {
    expect(sectionFor(report({ browsers: [BUSY] })).reapable).toBe(false);
    expect(sectionFor(report({ browsers: [BUSY, IDLE] })).reapable).toBe(true);
  });

  it('keeps the latest report in the board state', () => {
    const latest = report({ browsers: [IDLE], reapedCount: 2, freedMb: 600 });

    expect(applyCompanyMessage(stateFrom(), latest).state.browserReaper).toEqual(latest);
  });

  it('routes the report to the company client and builds the Dọn ngay command', () => {
    expect(isCompanyServerMessage({ type: 'browserReaperStatus' })).toBe(true);
    expect(browserReaperReapNow()).toEqual({ type: 'browserReaperReapNow' });
  });
});
