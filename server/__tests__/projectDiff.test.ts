import { describe, expect, it, vi } from 'vitest';

import type { ProjectDiffRequestMessage, ProjectMergePreviewRequestMessage } from '../../core/src/messages.js';
import { getProjectDiff, type ProjectDiffServices } from '../src/projects/diff.js';
import { previewProjectMerge, type ProjectMergePreviewServices } from '../src/projects/mergePreview.js';
import type { ProjectStore } from '../src/projects/projectStore.js';
import type { ProjectModuleDeps } from '../src/projects/services.js';

const requestId = 'req';
const store = {} as ProjectStore;

describe('project diff and merge allowlists', () => {
  it('refuses a diff checkout absent from the project tree before running git', async () => {
    const run = vi.fn(async () => { throw new Error('git must not run'); });
    const services: ProjectDiffServices = { git: { run }, events: () => [], sessions: () => [] };
    const deps: ProjectModuleDeps<ProjectDiffServices> = { store, loadTree: async () => ({ nodes: [] }), services };
    const request: ProjectDiffRequestMessage = { type: 'projectDiffRequest', requestId, checkout: 'V:/unknown', scope: 'uncommitted', sha: '' };
    await expect(getProjectDiff(request, deps)).rejects.toThrow('không có trong cây Project');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a merge repo absent from the project tree before running git', async () => {
    const run = vi.fn(async () => { throw new Error('git must not run'); });
    const services: ProjectMergePreviewServices = { git: { run } };
    const deps: ProjectModuleDeps<ProjectMergePreviewServices> = { store, loadTree: async () => ({ nodes: [] }), services };
    const request: ProjectMergePreviewRequestMessage = { type: 'projectMergePreviewRequest', requestId, repo: 'V:/unknown', branchA: 'main', branchB: 'topic' };
    await expect(previewProjectMerge(request, deps)).rejects.toThrow('không có trong cây Project');
    expect(run).not.toHaveBeenCalled();
  });
});
