import { describe, expect, it } from 'vitest';

import type {
  CompanyWorkspaceEntry,
  HerdrAgent,
  HerdrSleepingSession,
} from '../../core/src/messages.js';
import { herdrGroup } from '../src/company/agentSidebarView.js';
import {
  applyCompanyMessage,
  applyFocusFolder,
  applyViewMode,
  type CompanyViewState,
  EMPTY_SELECTION,
  emptyCompanyState,
} from '../src/company/companyState.js';
import { drawerSubjectFor, herdrPaneHidden } from '../src/company/selection.js';

const NOW = Date.parse('2026-05-01T10:30:00.000Z');
const ACTIVE = 'D:\\Duancanhan\\Project_QuanLyGiaiDau';
const OTHER = 'V:\\Duancanhan\\AICheckVAR';
const SCRATCH = 'D:\\Scratch';

function folder(path: string, active: boolean): CompanyWorkspaceEntry {
  return { path, active, open: true, working: 0, waiting: 0 };
}

function herdrAgent(overrides: Pick<HerdrAgent, 'paneId'> & Partial<HerdrAgent>): HerdrAgent {
  return { kind: 'claude', status: 'idle', workspaceId: 'ws-1', ...overrides };
}

function sleeping(paneId: string, workspacePath?: string): HerdrSleepingSession {
  return {
    paneId,
    title: '',
    sessionFile: `/sessions/${paneId}.jsonl`,
    sleptAt: '2026-05-01T10:25:00.000Z',
    workspacePath,
  };
}

/** A board with a folder list (the active folder is ACTIVE) and a roster of three agents and two sessions. */
function boardWithRoster(): CompanyViewState {
  const listed = applyCompanyMessage(emptyCompanyState(), {
    type: 'companyWorkspaces',
    workspaces: [folder(ACTIVE, true), folder(OTHER, false)],
  }).state;
  return applyCompanyMessage(listed, {
    type: 'herdrAgents',
    available: true,
    agents: [
      herdrAgent({ paneId: 'in', workspacePath: ACTIVE }),
      herdrAgent({ paneId: 'out', workspacePath: OTHER }),
      herdrAgent({ paneId: 'loose' }),
    ],
    sleeping: [sleeping('in-sleep', ACTIVE), sleeping('out-sleep', OTHER)],
  }).state;
}

function agentPanes(state: CompanyViewState): string[] {
  return state.herdr.agents.map((agent) => agent.paneId);
}

function sleepingPanes(state: CompanyViewState): string[] {
  return state.herdr.sleeping.map((session) => session.paneId);
}

describe('herdr panes in the folder view', () => {
  it('shows every pane in all mode, including panes tagged with no folder', () => {
    const state = boardWithRoster();
    expect(state.viewMode).toBe('all');
    expect(agentPanes(state)).toEqual(['in', 'out', 'loose']);
    expect(sleepingPanes(state)).toEqual(['in-sleep', 'out-sleep']);
  });

  it('shows only the active folder panes in folder mode', () => {
    const state = applyViewMode(boardWithRoster(), 'folder');
    expect(agentPanes(state)).toEqual(['in']);
    expect(sleepingPanes(state)).toEqual(['in-sleep']);
  });

  it('keeps the whole roster held while folder mode hides part of it', () => {
    const state = applyViewMode(boardWithRoster(), 'folder');
    expect(state.herdrRoster.agents.map((agent) => agent.paneId)).toEqual(['in', 'out', 'loose']);
    expect(state.herdrRoster.sleeping.map((session) => session.paneId)).toEqual([
      'in-sleep',
      'out-sleep',
    ]);
  });

  it('restores the whole roster when the board returns to all mode', () => {
    const back = applyViewMode(applyViewMode(boardWithRoster(), 'folder'), 'all');
    expect(agentPanes(back)).toEqual(['in', 'out', 'loose']);
    expect(sleepingPanes(back)).toEqual(['in-sleep', 'out-sleep']);
  });

  it('re-derives the panes in view when the active folder changes', () => {
    const folderMode = applyViewMode(boardWithRoster(), 'folder');
    const moved = applyCompanyMessage(folderMode, {
      type: 'companyWorkspaces',
      workspaces: [folder(ACTIVE, false), folder(OTHER, true)],
    }).state;
    expect(agentPanes(moved)).toEqual(['out']);
    expect(sleepingPanes(moved)).toEqual(['out-sleep']);
  });

  it('reads a folder with no panes as a loaded, empty herdr group', () => {
    const state = applyCompanyMessage(applyViewMode(boardWithRoster(), 'folder'), {
      type: 'companyWorkspaces',
      workspaces: [folder(ACTIVE, false), folder(OTHER, false), folder(SCRATCH, true)],
    }).state;
    expect(herdrGroup(state.herdr, NOW)).toEqual({ kind: 'ready', repos: [] });
  });

  it('keeps the same pane lists when an unrelated change re-derives the view', () => {
    const state = applyViewMode(boardWithRoster(), 'folder');
    const refocused = applyFocusFolder(state, OTHER);
    expect(refocused.herdr.agents).toBe(state.herdr.agents);
    expect(refocused.herdr.sleeping).toBe(state.herdr.sleeping);
  });
});

describe('a herdr selection in the folder view', () => {
  it('is dropped when its pane leaves the folder view on a mode switch', () => {
    const state: CompanyViewState = {
      ...boardWithRoster(),
      selection: { ...EMPTY_SELECTION, herdrPaneId: 'out' },
    };
    expect(applyViewMode(state, 'folder').selection.herdrPaneId).toBeNull();
  });

  it('is kept while its pane stays in the folder view', () => {
    const state: CompanyViewState = {
      ...boardWithRoster(),
      selection: { ...EMPTY_SELECTION, herdrPaneId: 'in' },
    };
    expect(applyViewMode(state, 'folder').selection.herdrPaneId).toBe('in');
  });
});

describe('the drawer on a herdr pane the folder view hides', () => {
  it('shows nothing for a pane of another folder, agent or session, in folder mode', () => {
    const folderMode = applyViewMode(boardWithRoster(), 'folder');
    expect(herdrPaneHidden(folderMode, 'out')).toBe(true);
    expect(drawerSubjectFor(folderMode, { kind: 'herdr', paneId: 'out' })).toBeNull();
    expect(drawerSubjectFor(folderMode, { kind: 'sleeping', paneId: 'out-sleep' })).toBeNull();
  });

  it('shows the pane again in all mode', () => {
    expect(drawerSubjectFor(boardWithRoster(), { kind: 'herdr', paneId: 'out' })).toEqual({
      kind: 'herdr',
      paneId: 'out',
    });
  });

  it('does not treat a pane that is simply gone as hidden', () => {
    const folderMode = applyViewMode(boardWithRoster(), 'folder');
    expect(herdrPaneHidden(folderMode, 'missing')).toBe(false);
    expect(drawerSubjectFor(folderMode, { kind: 'herdr', paneId: 'missing' })).toEqual({
      kind: 'herdr',
      paneId: 'missing',
    });
  });
});
