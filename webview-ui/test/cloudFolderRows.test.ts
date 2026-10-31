import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FleetMachineSnapshot } from '../../core/src/messages.js';
import { CloudFolderRows, type CloudSessionsProps, CloudSessionsSection } from '../src/company/fleet/CloudSessionsSection.js';

const machines: FleetMachineSnapshot[] = [
  {
    agentId: 'danh',
    receivedAt: 0,
    state: 'online',
    sessionCount: 0,
    engines: [],
    repos: [],
    tmuxSessions: [],
  },
];

const props: CloudSessionsProps = {
  machines,
  onCreate: () => {},
  error: null,
  busy: false,
  request: null,
  nodes: [{ id: 'folder-1', kind: 'folder' }],
};

// The sessions themselves are rows of the Project tree now (cloudNodes.test.ts); this part keeps the request box and a failed create.
describe('cloud request box and errors under a tree node', () => {
  it('shows a failed create under the node that asked for it, not at the foot of the tree', () => {
    const failed = { ...props, error: 'May da du 3 viec', request: { engine: 'omp' as const, token: 1, nodeId: 'folder-1' } };
    expect(renderToStaticMarkup(createElement(CloudFolderRows, { ...failed, nodeId: 'folder-1', depth: 1 }))).toContain('May da du 3 viec');
    expect(renderToStaticMarkup(createElement(CloudSessionsSection, failed))).not.toContain('May da du 3 viec');
  });

  it('keeps a failed create at the foot of the tree when the node that asked is gone', () => {
    const failed = { ...props, nodes: [], error: 'May da du 3 viec', request: { engine: 'omp' as const, token: 1, nodeId: 'folder-1' } };
    expect(renderToStaticMarkup(createElement(CloudSessionsSection, failed))).toContain('May da du 3 viec');
  });

  it('renders nothing under a node that asked for no cloud session', () => {
    expect(renderToStaticMarkup(createElement(CloudFolderRows, { ...props, nodeId: 'folder-2', depth: 1 }))).toBe('');
    expect(renderToStaticMarkup(createElement(CloudSessionsSection, props))).toBe('');
  });
});
