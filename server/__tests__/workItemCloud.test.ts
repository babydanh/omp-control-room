import { describe, expect, it } from 'vitest';

import type { WorkItem } from '../../core/src/messages.js';
import {
  countUncommittedFiles,
  parseFastHandoffResult,
  parseOpenCloudIssues,
  parseOrchestratorComment,
  parseOrchestratorComments,
  updateCloudHandoff,
} from '../src/company/workItems/workItemCloud.js';
import { parseStoredItem } from '../src/company/workItems/workItemModel.js';

const STORED_ITEM = {
  id: '00000000-0000-4000-8000-000000000042',
  text: 'Sửa API',
  assignee: { kind: 'new-session' },
  status: 'done',
  sequence: 1,
  priority: 2,
  dependsOn: [],
  createdAt: '2026-05-01T08:00:00.000Z',
  updatedAt: '2026-05-01T08:00:00.000Z',
  history: [],
  worktree: { path: 'D:\\work\\item', branch: 'squad-42' },
};

describe('parseStoredItem cloud field', () => {
  it('persists a valid cloud handoff state', () => {
    const cloud = {
      issue: 42,
      url: 'https://github.com/babydanh/agent-orchestrator/issues/42',
      branch: 'squad-42',
      repo: 'D:\\work\\repo',
      state: 'finished',
      startedAt: '2026-05-01T08:00:00.000Z',
      summary: 'Hoàn tất trên cloud',
      logUrl: 'https://github.com/babydanh/agent-orchestrator/actions/runs/123',
    } as const;
    expect(parseStoredItem({ ...STORED_ITEM, cloud })?.cloud).toEqual(cloud);
  });

  it('drops an invalid optional cloud record without losing the work item', () => {
    const parsed = parseStoredItem({ ...STORED_ITEM, cloud: { issue: '42', state: 'unknown' } });
    expect(parsed?.id).toBe(STORED_ITEM.id);
    expect(parsed?.cloud).toBeUndefined();
  });
});

describe('parseFastHandoffResult', () => {
  it.each([
    '>>> KICH HOAT CLOUD THANH CONG! LINK ISSUE: https://github.com/babydanh/agent-orchestrator/issues/42',
    '>>> DA KICH HOAT QUA GH CLI: https://github.com/babydanh/agent-orchestrator/issues/43',
  ])('reads an Issue URL from either success line: %s', (stdout) => {
    expect(parseFastHandoffResult({ code: 0, stdout, stderr: '' })).toMatchObject({
      url: expect.stringContaining('/issues/'),
      issue: Number(stdout.match(/issues\/(\d+)/)?.[1]),
    });
  });

  it('rejects exit 2 with the script refusal line', () => {
    expect(() => parseFastHandoffResult({
      code: 2,
      stdout: '>>> DUNG HANDOFF: khong tao duoc Issue',
      stderr: '',
    })).toThrow('DUNG HANDOFF');
  });
});

describe('parseOrchestratorComment', () => {
  it('reads the status summary and log link from the marker comment', () => {
    expect(parseOrchestratorComment([
      '**OMP Orchestrator:**',
      '✅ Hoàn tất trên cloud',
      '- repo: nhánh omp/issue-42, 3 file khác main',
      'Log: https://github.com/babydanh/agent-orchestrator/actions/runs/123',
    ].join('\n'))).toEqual({
      summary: '✅ Hoàn tất trên cloud',
      logUrl: 'https://github.com/babydanh/agent-orchestrator/actions/runs/123',
    });
  });
});

describe('cloud helper formatting and parsing', () => {
  const item = {
    ...STORED_ITEM,
    acceptance: 'Kiểm thử API đạt',
    history: [{ at: '2026-05-01T08:00:00.000Z', kind: 'note', message: 'Đã thử API' }],
  } as unknown as WorkItem;

  it('writes the handoff template fields and appends updates without replacing prior notes', () => {
    const fresh = updateCloudHandoff(undefined, item, '2026-05-01T08:30:00.000Z');
    expect(fresh).toContain('# Handoff: Sửa API');
    expect(fresh).toContain('Cập nhật: 2026-05-01 08:30 · bởi: omp · nhánh: squad-42 · OpenSpec: không có');
    expect(fresh).toContain('Xong khi: Kiểm thử API đạt');
    expect(fresh).toContain('| note | Đã thử API | 2026-05-01T08:00:00.000Z |');
    expect(fresh).toContain('## Ràng buộc đang có\n- không đổi (đã so)');
    const appended = updateCloudHandoff('ghi chú cũ\n', item, '2026-05-01T09:00:00.000Z');
    expect(appended).toContain('ghi chú cũ');
    expect(appended).toContain('## Cập nhật 2026-05-01 09:00 từ Agent Board');
  });

  it('counts the baseline as dirty before handoff but can ignore it during pull', () => {
    const status = '?? .ripwire_quality_baseline\n M src/work.ts\n';
    expect(countUncommittedFiles(status)).toBe(2);
    expect(countUncommittedFiles(status, true)).toBe(1);
  });

  it('lists unlinked handoff Issues and parses paginated orchestrator comments', () => {
    const issues = parseOpenCloudIssues(JSON.stringify([
      {
        number: 42,
        title: '[Handoff] Sửa API',
        url: 'https://github.com/babydanh/agent-orchestrator/issues/42',
        createdAt: '2026-05-01T08:00:00Z',
        body: '- **Repo mục tiêu**: D:\\work\\repo',
      },
      { number: 43, title: '[Bug] khác', url: 'url', createdAt: '2026-05-01T08:00:00Z' },
    ]), new Set([42]));
    expect(issues).toEqual([]);
    expect(parseOpenCloudIssues(JSON.stringify([{
      number: 42,
      title: '[Handoff] Sửa API',
      url: 'https://github.com/babydanh/agent-orchestrator/issues/42',
      createdAt: '2026-05-01T08:00:00Z',
      body: '- **Repo mục tiêu**: D:\\work\\repo',
    }]), new Set())).toMatchObject([{ repo: 'D:\\work\\repo', state: 'running' }]);
    expect(parseOrchestratorComments(JSON.stringify([[{
      body: '**OMP Orchestrator:**\nHoàn tất\nLog: https://github.com/actions/runs/1',
    }]]))).toMatchObject({ summary: 'Hoàn tất', logUrl: 'https://github.com/actions/runs/1' });
  });
});
