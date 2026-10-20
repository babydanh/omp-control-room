import { describe, expect, it } from 'vitest';

import type { WorkItemJudgeVerdict } from '../../core/src/messages.js';
import {
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_MAX,
  WORK_ITEM_PRIORITY_MIN,
} from '../../core/src/workItemGraph.js';
import {
  SEQUENCE_REF_PATTERN,
  SQUAD_LEADER_REPLY_SCHEMA,
} from '../src/company/squad/squadLeaderSchema.js';
import {
  type Checked,
  type LeaderReply,
  parseLeaderReply,
  SQUAD_MAX_ROWS,
  type SquadCatalog,
  type SquadMember,
} from '../src/company/squad/squadModel.js';
import {
  JUDGE_FOLLOW_UP_MAX_CHARS,
  JUDGE_REPLY_ERROR,
  parseJudgeReply,
} from '../src/company/workItems/judgeModel.js';
import { JUDGE_REPLY_SCHEMA } from '../src/company/workItems/judgeSchema.js';
import {
  JUDGE_REASON_MAX_CHARS,
  WORK_ITEM_AREAS_MAX,
} from '../src/company/workItems/workItemModel.js';

const REPO = '/work/folder/app';
const CATALOG: SquadCatalog = {
  repos: [REPO],
  agents: [
    { name: 'task', description: 'Làm việc', readOnly: false, source: 'bundled' },
    { name: 'scout', description: 'Tìm thông tin', readOnly: true, source: 'bundled' },
  ],
};
const MEMBERS: SquadMember[] = [
  {
    ref: 'session:s1',
    kind: 'session',
    assignee: { kind: 'session', sessionId: 's1' },
    label: 'Session 1',
    status: 'idle',
    role: '',
    queued: 0,
  },
];
const NO_OPEN: ReadonlySet<number> = new Set<number>();
/** Work items #1 and #42 are open. */
const OPEN_ITEMS: ReadonlySet<number> = new Set([1, 42]);

const VALID_ROW = {
  assignee: 'auto',
  text: 'Viết test cho form đăng nhập',
  reason: 'Việc chính',
  priority: 2,
  acceptance: 'Có test chạy được',
  dependsOn: [],
  repo: REPO,
  role: 'worker',
  agent: 'task',
  areas: ['web:src/app'],
};

function leaderReply(assignments: unknown[], done = false): Record<string, unknown> {
  return { assignments, note: 'Ghi chú', done };
}

function parseReply(value: unknown, open: ReadonlySet<number> = NO_OPEN): Checked<LeaderReply> {
  return parseLeaderReply(JSON.stringify(value), MEMBERS, CATALOG, open);
}

function valueOf<T>(checked: Checked<T>): T {
  if (!checked.ok) throw new Error(`expected an accepted reply, got: ${checked.message}`);
  return checked.value;
}

function refusalOf<T>(checked: Checked<T>): string {
  if (checked.ok) throw new Error('expected a refused reply');
  return checked.message;
}

const LEADER_ROW_SCHEMA = SQUAD_LEADER_REPLY_SCHEMA.properties.assignments.items;

describe('squad leader reply: claude assignee', () => {
  it('maps assignee claude to the claude work-item assignee', () => {
    const reply = valueOf(parseReply(leaderReply([{ ...VALID_ROW, assignee: 'claude' }])));
    expect(reply.assignments[0]?.assignee).toStrictEqual({ kind: 'claude' });
  });

  it('keeps the auto, new-session and member assignees as they were', () => {
    const omitted = valueOf(parseReply(leaderReply([{ text: 'Việc A' }])));
    expect(omitted.assignments[0]?.assignee).toStrictEqual({ kind: 'auto' });

    const auto = valueOf(parseReply(leaderReply([{ text: 'Việc A', assignee: 'auto' }])));
    expect(auto.assignments[0]?.assignee).toStrictEqual({ kind: 'auto' });

    const fresh = valueOf(parseReply(leaderReply([{ text: 'Việc A', assignee: 'new-session' }])));
    expect(fresh.assignments[0]?.assignee).toStrictEqual({ kind: 'new-session' });

    const member = valueOf(parseReply(leaderReply([{ text: 'Việc A', assignee: 'session:s1' }])));
    expect(member.assignments[0]?.assignee).toStrictEqual({ kind: 'session', sessionId: 's1' });
  });

  it('refuses an assignee that is not a known id', () => {
    for (const assignee of ['gemini', 'Claude', 'claude-code', 'herdr']) {
      const message = refusalOf(parseReply(leaderReply([{ text: 'Việc A', assignee }])));
      expect(message).toContain('không có trong danh sách thành viên');
    }
  });

  it('refuses an extra field on a claude row', () => {
    const message = refusalOf(
      parseReply(leaderReply([{ text: 'Việc A', assignee: 'claude', paneId: 'wA:p1' }])),
    );
    expect(message).toContain('trường không hỗ trợ');
  });
});

describe('squad leader reply schema', () => {
  it('requires exactly the top-level keys the parser requires', () => {
    expect([...SQUAD_LEADER_REPLY_SCHEMA.required]).toEqual(['assignments', 'note', 'done']);
    expect(SQUAD_LEADER_REPLY_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(SQUAD_LEADER_REPLY_SCHEMA.properties).sort()).toEqual([
      'assignments',
      'done',
      'note',
    ]);
    for (const key of SQUAD_LEADER_REPLY_SCHEMA.required) {
      const value: Record<string, unknown> = leaderReply([{ text: 'Việc A' }]);
      delete value[key];
      expect(parseReply(value).ok).toBe(false);
    }
  });

  it('refuses an extra top-level key, as the schema forbids', () => {
    const message = refusalOf(parseReply({ ...leaderReply([{ text: 'Việc A' }]), extra: 1 }));
    expect(message).toContain('trường không hỗ trợ');
  });

  it('requires only text on a row, as the parser does', () => {
    expect([...LEADER_ROW_SCHEMA.required]).toEqual(['text']);
    expect(refusalOf(parseReply(leaderReply([{ reason: 'Lý do' }])))).toContain('thiếu nội dung');
  });

  it('lists the same row keys in the schema and the parser', () => {
    expect(LEADER_ROW_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(LEADER_ROW_SCHEMA.properties).sort()).toEqual([
      'acceptance',
      'agent',
      'areas',
      'assignee',
      'dependsOn',
      'priority',
      'reason',
      'repo',
      'role',
      'text',
    ]);
    expect(parseReply(leaderReply([VALID_ROW])).ok).toBe(true);
  });

  it('keeps the closed role set equal to the item roles the parser takes', () => {
    const roles = LEADER_ROW_SCHEMA.properties.role.enum;
    expect([...roles]).toEqual(['advisor', 'worker', 'qa', 'judge', 'chat']);
    for (const role of roles) {
      const reply = valueOf(parseReply(leaderReply([{ text: 'Việc A', role }])));
      expect(reply.assignments[0]?.role).toBe(role);
    }
    expect(refusalOf(parseReply(leaderReply([{ text: 'Việc A', role: 'director' }])))).toContain(
      'vai trò không hợp lệ',
    );
  });

  it('rejects blank text, as the parser does', () => {
    const pattern = new RegExp(LEADER_ROW_SCHEMA.properties.text.pattern);
    expect(pattern.test('   ')).toBe(false);
    expect(pattern.test(' Việc A ')).toBe(true);
    expect(refusalOf(parseReply(leaderReply([{ text: '   ' }])))).toContain('không có nội dung');
  });

  it('keeps the numeric limits equal to the parser limits', () => {
    expect(SQUAD_LEADER_REPLY_SCHEMA.properties.assignments.maxItems).toBe(SQUAD_MAX_ROWS);
    const tooMany = Array.from({ length: SQUAD_MAX_ROWS + 1 }, () => ({ text: 'Việc' }));
    expect(refusalOf(parseReply(leaderReply(tooMany)))).toContain(`tối đa ${SQUAD_MAX_ROWS}`);

    expect(LEADER_ROW_SCHEMA.properties.acceptance.maxLength).toBe(WORK_ITEM_ACCEPTANCE_MAX_CHARS);
    expect(LEADER_ROW_SCHEMA.properties.areas.maxItems).toBe(WORK_ITEM_AREAS_MAX);
    expect(LEADER_ROW_SCHEMA.properties.dependsOn.maxItems).toBe(WORK_ITEM_DEPENDS_MAX);
    expect(LEADER_ROW_SCHEMA.properties.priority.minimum).toBe(WORK_ITEM_PRIORITY_MIN);
    expect(LEADER_ROW_SCHEMA.properties.priority.maximum).toBe(WORK_ITEM_PRIORITY_MAX);

    const accepted = valueOf(parseReply(leaderReply([{ text: 'Việc', priority: 3 }])));
    expect(accepted.assignments[0]?.priority).toBe(WORK_ITEM_PRIORITY_MAX);
    expect(refusalOf(parseReply(leaderReply([{ text: 'Việc', priority: 4 }])))).toContain(
      'độ ưu tiên',
    );
  });

  it('matches dependsOn references to the form the parser reads', () => {
    const pattern = new RegExp(SEQUENCE_REF_PATTERN);
    for (const ref of ['#1', '#42']) {
      expect(pattern.test(ref)).toBe(true);
      const reply = parseReply(leaderReply([{ text: 'Việc A', dependsOn: [ref] }]), OPEN_ITEMS);
      expect(reply.ok).toBe(true);
    }
    for (const ref of ['#0', '#01', '#', '1', '#1 ']) {
      expect(pattern.test(ref)).toBe(false);
      const message = refusalOf(
        parseReply(leaderReply([{ text: 'Việc A', dependsOn: [ref] }]), OPEN_ITEMS),
      );
      expect(message).toContain('không hợp lệ');
    }
  });
});

const JUDGE_VALID = { verdict: 'fail', reason: 'Thiếu test.', followUp: 'Thêm test.' };

function judgeReply(value: unknown) {
  return parseJudgeReply(JSON.stringify(value));
}

describe('judge reply schema', () => {
  it('requires exactly the keys the parser requires', () => {
    expect([...JUDGE_REPLY_SCHEMA.required]).toEqual(['verdict', 'reason', 'followUp']);
    for (const key of JUDGE_REPLY_SCHEMA.required) {
      const value: Record<string, unknown> = { ...JUDGE_VALID };
      delete value[key];
      expect(judgeReply(value).ok).toBe(false);
    }
  });

  it('takes the core verdict set as its verdict enum', () => {
    const coreVerdicts: Record<WorkItemJudgeVerdict, true> = {
      pass: true,
      fail: true,
      need_evidence: true,
    };
    const enumValues = [...JUDGE_REPLY_SCHEMA.properties.verdict.enum];
    expect(enumValues.slice().sort()).toEqual(Object.keys(coreVerdicts).sort());
    for (const verdict of Object.keys(coreVerdicts)) {
      const followUp = verdict === 'pass' ? '' : 'Làm tiếp';
      expect(judgeReply({ verdict, reason: 'Lý do', followUp }).ok).toBe(true);
    }
    expect(judgeReply({ verdict: 'maybe', reason: 'Lý do', followUp: 'Làm tiếp' }).ok).toBe(false);
  });

  it('keeps the reason and follow-up limits equal to the parser limits', () => {
    expect(JUDGE_REPLY_SCHEMA.properties.reason.maxLength).toBe(JUDGE_REASON_MAX_CHARS);
    expect(JUDGE_REPLY_SCHEMA.properties.followUp.maxLength).toBe(JUDGE_FOLLOW_UP_MAX_CHARS);

    const longFollowUp = 'x'.repeat(JUDGE_FOLLOW_UP_MAX_CHARS + 1);
    expect(judgeReply({ ...JUDGE_VALID, followUp: longFollowUp })).toEqual({
      ok: false,
      error: JUDGE_REPLY_ERROR.followUpLong,
    });

    const blankReason = new RegExp(JUDGE_REPLY_SCHEMA.properties.reason.pattern);
    expect(blankReason.test('   ')).toBe(false);
    expect(judgeReply({ ...JUDGE_VALID, reason: '   ' })).toEqual({
      ok: false,
      error: JUDGE_REPLY_ERROR.reasonMissing,
    });
  });

  it('leaves extra keys open, as the parser does', () => {
    expect(JUDGE_REPLY_SCHEMA).not.toHaveProperty('additionalProperties');
    expect(judgeReply({ verdict: 'pass', reason: 'Đạt', followUp: '', extra: 1 }).ok).toBe(true);
  });
});
