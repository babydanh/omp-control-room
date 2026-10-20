import { describe, expect, it } from 'vitest';

import type { OmpAgentInfo, WorkItemAssignee } from '../../core/src/messages.js';
import {
  agentChipOf,
  agentNameOf,
  agentOptionLabel,
  areasFromText,
  completenessRowOf,
  liveWarnings,
  readOnlyAgentNames,
  repoChipLabel,
  ROOT_REPO_LABEL,
} from '../src/company/squadPlanCheck.js';
import type { SquadDraftRow } from '../src/company/squadView.js';
import { repoShortName } from '../src/company/workItemView.js';

const AGENTS: OmpAgentInfo[] = [
  { name: 'scout', description: 'Tìm thông tin', readOnly: true, source: 'bundled' },
  { name: 'task', description: 'Sửa code', readOnly: false, source: 'bundled' },
  { name: 'reviewer', description: 'Review code', readOnly: true, source: 'bundled' },
];

const HERDR: WorkItemAssignee = { kind: 'herdr', paneId: 'p-1' };

function draftRow(overrides: Partial<SquadDraftRow> = {}): SquadDraftRow {
  return {
    key: 'row-1',
    text: 'Viết API',
    repo: null,
    role: null,
    agent: '',
    areas: '',
    assignee: null,
    priority: 2,
    acceptance: 'Có endpoint',
    dependsOn: [],
    ...overrides,
  };
}

describe('areasFromText', () => {
  it('splits on commas, trims and lowercases, and drops blanks and repeats', () => {
    expect(areasFromText(' Auth, billing ,auth,, ')).toEqual(['auth', 'billing']);
  });

  it('is empty for blank text', () => {
    expect(areasFromText('   ')).toEqual([]);
  });
});

describe('agent helpers', () => {
  it('reads an empty agent as the default worker', () => {
    expect(agentNameOf('')).toBe('task');
    expect(agentNameOf('scout')).toBe('scout');
  });

  it('collects the read-only agent names of the catalog', () => {
    expect(readOnlyAgentNames(AGENTS)).toEqual(new Set(['scout', 'reviewer']));
  });

  it('marks a read-only agent in its option label', () => {
    expect(agentOptionLabel(AGENTS[0])).toBe('scout · chỉ đọc');
    expect(agentOptionLabel(AGENTS[1])).toBe('task');
  });

  it('reads a row agent against the catalog: read-only, or missing from it', () => {
    expect(agentChipOf('', AGENTS)).toEqual({ name: 'task', readOnly: false, missing: false });
    expect(agentChipOf('scout', AGENTS)).toEqual({
      name: 'scout',
      readOnly: true,
      missing: false,
    });
    expect(agentChipOf('gone', AGENTS)).toEqual({ name: 'gone', readOnly: false, missing: true });
  });
});

describe('repoChipLabel', () => {
  it('labels a row at the folder root, and any other repo by its short name', () => {
    expect(repoChipLabel(null)).toBe(ROOT_REPO_LABEL);
    expect(repoChipLabel('/work/alpha')).toBe(repoShortName('/work/alpha'));
  });
});

describe('completenessRowOf', () => {
  it('maps a draft row to the shared check: default agent unset, areas parsed, assignee kind kept', () => {
    expect(
      completenessRowOf(
        draftRow({
          agent: '',
          areas: 'Auth, api',
          assignee: HERDR,
          dependsOn: [{ kind: 'row', row: 0 }],
        }),
      ),
    ).toEqual({
      text: 'Viết API',
      acceptance: 'Có endpoint',
      agent: undefined,
      areas: ['auth', 'api'],
      dependsOn: [{ kind: 'row', row: 0 }],
      assigneeKind: 'herdr',
    });
  });
});

describe('liveWarnings', () => {
  it('warns that a herdr pane only hints at a named subagent, by row number', () => {
    expect(liveWarnings([draftRow({ assignee: HERDR, agent: 'scout' })], AGENTS)).toEqual([
      'Agent herdr: subagent chỉ là gợi ý (#1)',
    ]);
  });

  it('does not treat the default worker on a herdr pane as a hint', () => {
    expect(liveWarnings([draftRow({ assignee: HERDR })], AGENTS)).toEqual([
      'Thiếu bước review cho #1',
    ]);
  });

  it('accepts a code-changing row that a reviewer waits on', () => {
    expect(
      liveWarnings(
        [
          draftRow({ key: 'row-1' }),
          draftRow({
            key: 'row-2',
            text: 'Review',
            agent: 'reviewer',
            dependsOn: [{ kind: 'row', row: 0 }],
          }),
        ],
        AGENTS,
      ),
    ).toEqual([]);
  });

  it('warns about a missing acceptance line before the herdr hint, in row order', () => {
    expect(
      liveWarnings([draftRow({ acceptance: '   ', assignee: HERDR, agent: 'scout' })], AGENTS),
    ).toEqual(['Thiếu tiêu chí nghiệm thu cho #1', 'Agent herdr: subagent chỉ là gợi ý (#1)']);
  });

  it('suggests a security review for a row that touches a risky topic, naming the topic', () => {
    expect(
      liveWarnings([draftRow({ text: 'Đổi token đăng nhập', agent: 'scout' })], AGENTS),
    ).toEqual(['Nên có review bảo mật cho #1 (đụng auth)']);
  });
});
