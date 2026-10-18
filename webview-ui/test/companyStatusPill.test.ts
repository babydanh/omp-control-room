import { describe, expect, it } from 'vitest';

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../core/src/constants.js';
import { type StatusPillView, statusPillView } from '../src/company/statusPillView.js';
import { stateFrom } from './companyFixtures.js';

const DIAGNOSTICS = {
  liveRunners: 1,
  modelLeases: 2,
  nativeJobs: 0,
  queuedTasks: 3,
  pendingQuestions: 0,
  retainedSessions: 4,
  archivedSessions: 0,
  terminalBufferedBytes: 0,
  ownedHandleCount: 0,
  measuredAt: '2026-01-01T00:00:00.000Z',
};

function row(view: StatusPillView, label: string) {
  return view.rows.find((item) => item.label === label);
}

describe('statusPillView', () => {
  it('is calm and summarised by the omp runner when connected with nothing spent', () => {
    const view = statusPillView(TRANSPORT_STATE_CONNECTED, stateFrom({ diagnostics: DIAGNOSTICS }));

    expect(view.tone).toBe('calm');
    expect(view.summary).toBe('đang chạy 1/2 · xếp hàng 3 · giữ lại 4');
    expect(row(view, 'Kết nối')).toEqual({
      label: 'Kết nối',
      value: 'đã kết nối',
      attention: false,
    });
    expect(row(view, 'omp')?.value).toBe('đang chạy 1/2 · xếp hàng 3 · giữ lại 4');
  });

  it('shows the omp runner as unknown, not zero, until the server reports diagnostics', () => {
    const view = statusPillView(TRANSPORT_STATE_CONNECTED, stateFrom());

    expect(row(view, 'omp')?.value).toBe('chưa có số liệu');
    expect(view.summary).toBe('omp');
  });

  it('shows the model catalog as loading until the server has answered', () => {
    const view = statusPillView(TRANSPORT_STATE_CONNECTED, stateFrom());

    expect(row(view, 'Mô hình')?.value).toBe('đang tải…');
  });

  it('draws the pill in attention and says so while the link is down', () => {
    const view = statusPillView(TRANSPORT_STATE_RECONNECTING, stateFrom());

    expect(view.tone).toBe('attention');
    expect(view.summary).toBe('đang kết nối lại…');
    expect(row(view, 'Kết nối')?.attention).toBe(true);
  });

  it('draws the pill in attention when a quota window is spent', () => {
    const view = statusPillView(
      TRANSPORT_STATE_CONNECTED,
      stateFrom({
        quotas: [
          {
            provider: 'anthropic',
            accountLabel: 'main',
            windows: [{ label: '5 giờ', remaining: 0, reportedUnit: 'lượt' }],
            fetchedAt: '2026-01-01T00:00:00.000Z',
            status: 'available',
          },
        ],
      }),
    );

    expect(view.tone).toBe('attention');
    expect(row(view, 'anthropic 5 giờ')).toEqual({
      label: 'anthropic 5 giờ',
      value: '0 lượt',
      attention: true,
    });
  });
});
