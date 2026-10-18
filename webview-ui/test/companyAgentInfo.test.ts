import { describe, expect, it } from 'vitest';

import type {
  AgentInfo,
  AgentSkillInfo,
  AgentToolInfo,
  AgentToolUsage,
  HerdrAgent,
} from '../../core/src/company.js';
import {
  collectedLine,
  groupToolsBySource,
  inferMcpServers,
  matchesFilter,
  mcpGap,
  mcpServerViews,
  modelLine,
  skillsGap,
  sortSkills,
  toolsGap,
  usageBars,
  usageGap,
  workingFolder,
} from '../src/company/agentInfoView.js';
import { applyCompanyMessage, emptyCompanyState } from '../src/company/companyState.js';
import { session, snapshot, stateFrom } from './companyFixtures.js';

function agentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return { collectedFrom: 'live', collectedAt: '2026-10-02T10:00:00.000Z', ...overrides };
}

function tool(name: string, overrides: Partial<AgentToolInfo> = {}): AgentToolInfo {
  return { name, source: 'builtin', active: true, ...overrides };
}

function herdrAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    paneId: 'pane-1',
    kind: 'claude',
    status: 'working',
    workspaceId: 'ws-1',
    name: 'claude-1',
    ...overrides,
  };
}

const MIXED_TOOLS: AgentToolInfo[] = [
  tool('bash', { active: false }),
  tool('read'),
  tool('ext_ui', { source: 'extension' }),
  tool('github_pr', { source: 'mcp', mcpServer: 'github', active: false }),
  tool('github_search', { source: 'mcp', mcpServer: 'github' }),
  tool('fs_read', { source: 'mcp', mcpServer: 'filesystem' }),
  tool('sdk_run', { source: 'sdk' }),
  tool('odd', { source: 'other' }),
];

describe('groupToolsBySource', () => {
  it('groups tools in reading order: builtin, extension, MCP per server, SDK, other', () => {
    const groups = groupToolsBySource(MIXED_TOOLS);

    expect(groups.map((group) => group.label)).toEqual([
      'Builtin',
      'Extension',
      'MCP · filesystem',
      'MCP · github',
      'SDK',
      'Khác',
    ]);
  });

  it('puts active tools first, then sorts by name, and counts the active ones', () => {
    const groups = groupToolsBySource(MIXED_TOOLS);
    const builtin = groups.find((group) => group.key === 'builtin');
    const github = groups.find((group) => group.key === 'mcp:github');

    expect(builtin?.tools.map((t) => t.name)).toEqual(['read', 'bash']);
    expect(github?.tools.map((t) => t.name)).toEqual(['github_search', 'github_pr']);
    expect(github?.activeCount).toBe(1);
  });

  it('files an MCP tool with no server name under an unknown server', () => {
    const groups = groupToolsBySource([tool('mystery', { source: 'mcp' })]);

    expect(groups.map((group) => group.label)).toEqual(['MCP · không rõ máy chủ']);
  });

  it('drops groups that have no tools', () => {
    expect(groupToolsBySource([tool('read')]).map((group) => group.key)).toEqual(['builtin']);
  });
});

describe('inferMcpServers', () => {
  it('reads a multi-word server from the prefix its tools share', () => {
    const tools = [
      tool('mcp__botkeep_cloud_devdocs_search', { source: 'mcp', mcpServer: 'botkeep' }),
      tool('mcp__botkeep_cloud_diff_validator', { source: 'mcp', mcpServer: 'botkeep' }),
      tool('mcp__cua_driver_click', { source: 'mcp', mcpServer: 'cua' }),
      tool('mcp__cua_driver_bring_to_front', { source: 'mcp', mcpServer: 'cua' }),
      tool('mcp__solo_only', { source: 'mcp', mcpServer: 'solo' }),
    ];

    const servers = inferMcpServers(tools);

    expect(servers.get('mcp__botkeep_cloud_devdocs_search')).toBe('botkeep_cloud');
    expect(servers.get('mcp__cua_driver_bring_to_front')).toBe('cua_driver');
    // One tool cannot show where the server name ends; the source's guess stands.
    expect(servers.has('mcp__solo_only')).toBe(false);
    expect(groupToolsBySource(tools).map((group) => group.label)).toEqual([
      'MCP · botkeep_cloud',
      'MCP · cua_driver',
      'MCP · solo',
    ]);
  });
});

describe('mcpServerViews', () => {
  it('counts each server’s tools and the calls to them, used servers first', () => {
    const views = mcpServerViews(
      [...MIXED_TOOLS, tool('idle_tool', { source: 'mcp', mcpServer: 'idle' })],
      [
        { name: 'fs_read', count: 1 },
        { name: 'github_search', count: 3 },
      ],
    );

    expect(views).toEqual([
      { name: 'github', toolCount: 2, activeCount: 1, usageCount: 3, used: true },
      { name: 'filesystem', toolCount: 1, activeCount: 1, usageCount: 1, used: true },
      { name: 'idle', toolCount: 1, activeCount: 1, usageCount: 0, used: false },
    ]);
  });
});

describe('sortSkills', () => {
  it('lists the skills the agent used first, each half in name order', () => {
    const skills: AgentSkillInfo[] = [
      { name: 'zeta', used: false },
      { name: 'alpha', used: false },
      { name: 'mid', used: true },
    ];

    expect(sortSkills(skills).map((skill) => skill.name)).toEqual(['mid', 'alpha', 'zeta']);
  });
});

describe('usageBars', () => {
  it('ranks the most used tools, scales them to the top one, and drops unused ones', () => {
    const usage: AgentToolUsage[] = [
      { name: 'a', count: 2 },
      { name: 'b', count: 8 },
      { name: 'c', count: 0 },
      { name: 'd', count: 4 },
    ];

    expect(usageBars(usage)).toEqual([
      { name: 'b', count: 8, share: 1 },
      { name: 'd', count: 4, share: 0.5 },
      { name: 'a', count: 2, share: 0.25 },
    ]);
  });

  it('draws at most the limit', () => {
    const usage = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, count: i + 1 }));
    const bars = usageBars(usage);

    expect(bars).toHaveLength(10);
    expect(bars[0]).toEqual({ name: 't11', count: 12, share: 1 });
  });
});

describe('matchesFilter', () => {
  it('matches case-insensitively and lets a blank filter pass everything', () => {
    expect(matchesFilter('Read', 'rea')).toBe(true);
    expect(matchesFilter('Read', '  ')).toBe(true);
    expect(matchesFilter('Read', 'zz')).toBe(false);
  });
});

describe('info labels', () => {
  it('names the folder the agent works in, falling back to where it launched', () => {
    expect(workingFolder(agentInfo({ cwd: '/repo', launchCwd: '/start' }))).toBe('/repo');
    expect(workingFolder(agentInfo({ cwd: '', launchCwd: '/start' }))).toBe('/start');
    expect(workingFolder(agentInfo())).toBeNull();
  });

  it('shows the model and thinking level, naming what is unknown', () => {
    expect(modelLine(agentInfo({ model: 'gpt-x', thinking: 'high' }))).toBe('gpt-x · high');
    expect(modelLine(agentInfo({ thinking: 'high' }))).toBe('chưa rõ · high');
    expect(modelLine(agentInfo())).toBe('chưa rõ');
  });

  it('says where and when the info was read', () => {
    expect(collectedLine(agentInfo({ collectedFrom: 'transcript' }))).toMatch(
      /^Lấy từ nhật ký phiên lúc \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('says a section is unknown when the source did not report it', () => {
    const unknown = agentInfo({ collectedFrom: 'herdr' });

    expect(toolsGap(unknown)).toBe('Chưa rõ danh sách tool: herdr không báo cáo mục này.');
    expect(mcpGap(unknown)).toBe('Chưa rõ máy chủ MCP: herdr không báo cáo mục này.');
    expect(skillsGap(unknown)).toBe('Chưa rõ skill: herdr không báo cáo mục này.');
    expect(usageGap(unknown)).toBe('Chưa rõ số lần dùng tool: herdr không báo cáo mục này.');
  });

  it('says a reported section is empty rather than unknown', () => {
    const empty = agentInfo({ tools: [], skills: [], toolUsage: [] });

    expect(toolsGap(empty)).toBe('Phiên này không báo cáo tool nào.');
    expect(mcpGap(empty)).toBe('Không có máy chủ MCP nào được báo cáo.');
    expect(skillsGap(empty)).toBe('Không có skill nào được nạp.');
    expect(usageGap(empty)).toBe('Chưa dùng tool nào.');
  });

  it('has no gap where the section has content', () => {
    const full = agentInfo({
      tools: [tool('read'), tool('fs', { source: 'mcp', mcpServer: 'filesystem' })],
      skills: [{ name: 'x', used: false }],
      toolUsage: [{ name: 'read', count: 1 }],
    });

    expect(toolsGap(full)).toBeNull();
    expect(mcpGap(full)).toBeNull();
    expect(skillsGap(full)).toBeNull();
    expect(usageGap(full)).toBeNull();
  });
});

describe('agent info reducer', () => {
  it('keeps the info with the newest collection time per session', () => {
    const state = stateFrom({ sessions: [session({ id: 's1' })] });
    const newer = agentInfo({ cwd: '/new', collectedAt: '2026-10-02T10:05:00.000Z' });
    const older = agentInfo({ cwd: '/old', collectedAt: '2026-10-02T10:00:00.000Z' });

    const once = applyCompanyMessage(state, {
      type: 'companySessionInfo',
      requestId: 'r1',
      sessionId: 's1',
      info: newer,
    }).state;
    const late = applyCompanyMessage(once, {
      type: 'companySessionInfo',
      requestId: 'r2',
      sessionId: 's1',
      info: older,
    }).state;

    expect(late.sessionInfos.s1).toEqual(newer);
  });

  it('replaces the stored info with a newer reply', () => {
    const state = stateFrom({ sessions: [session({ id: 's1' })] });
    const newer = agentInfo({ cwd: '/new', collectedAt: '2026-10-02T10:05:00.000Z' });

    const next = applyCompanyMessage(state, {
      type: 'companySessionInfo',
      requestId: 'r1',
      sessionId: 's1',
      info: newer,
    }).state;

    expect(next.sessionInfos.s1).toEqual(newer);
  });

  it('keeps the latest herdr info per pane and drops panes herdr no longer lists', () => {
    let state = emptyCompanyState();
    state = applyCompanyMessage(state, {
      type: 'herdrAgents',
      available: true,
      agents: [herdrAgent({ paneId: 'p1' }), herdrAgent({ paneId: 'p2' })],
    }).state;
    state = applyCompanyMessage(state, {
      type: 'herdrInfo',
      requestId: 'r1',
      paneId: 'p1',
      info: agentInfo({ collectedFrom: 'herdr', cwd: '/p1' }),
    }).state;
    state = applyCompanyMessage(state, {
      type: 'herdrInfo',
      requestId: 'r2',
      paneId: 'p2',
      info: agentInfo({ collectedFrom: 'herdr' }),
    }).state;
    expect(Object.keys(state.herdr.infos).sort()).toEqual(['p1', 'p2']);

    state = applyCompanyMessage(state, {
      type: 'herdrAgents',
      available: true,
      agents: [herdrAgent({ paneId: 'p1' })],
    }).state;
    expect(Object.keys(state.herdr.infos)).toEqual(['p1']);
  });

  it('ignores a stale herdr reply that is older than the stored one', () => {
    let state = emptyCompanyState();
    state = applyCompanyMessage(state, {
      type: 'herdrAgents',
      available: true,
      agents: [herdrAgent({ paneId: 'p1' })],
    }).state;
    const newer = agentInfo({
      collectedFrom: 'herdr',
      cwd: '/new',
      collectedAt: '2026-10-02T11:00:00.000Z',
    });
    const older = agentInfo({
      collectedFrom: 'herdr',
      cwd: '/old',
      collectedAt: '2026-10-02T09:00:00.000Z',
    });

    state = applyCompanyMessage(state, {
      type: 'herdrInfo',
      requestId: 'r1',
      paneId: 'p1',
      info: newer,
    }).state;
    state = applyCompanyMessage(state, {
      type: 'herdrInfo',
      requestId: 'r2',
      paneId: 'p1',
      info: older,
    }).state;

    expect(state.herdr.infos.p1).toEqual(newer);
  });

  it('drops the info of a session the snapshot no longer lists', () => {
    const state = stateFrom({ sessions: [session({ id: 's1' })] });
    const withInfo = applyCompanyMessage(state, {
      type: 'companySessionInfo',
      requestId: 'r1',
      sessionId: 's1',
      info: agentInfo({ cwd: '/x' }),
    }).state;

    const resynced = applyCompanyMessage(withInfo, {
      type: 'companySnapshot',
      requestId: 'r2',
      snapshot: snapshot({ sessions: [] }),
    }).state;

    expect(resynced.sessionInfos).toEqual({});
  });
});
