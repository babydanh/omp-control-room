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
    sessionCount: 2,
    engines: [],
    repos: [],
    tmuxSessions: [
      { name: 'fix-ab12', attached: false, idleSeconds: 5 },
      { name: 'old-task', attached: false, idleSeconds: 900 },
    ],
  },
];

const props: CloudSessionsProps = {
  machines,
  refresh: () => {},
  onOpenTerminal: () => {},
  onOpenDiff: () => {},
  onCreate: () => {},
  pending: null,
  error: null,
  busy: false,
  request: null,
  selected: null,
  folders: { 'danh/fix-ab12': 'folder-1' },
  nodes: [{ id: 'folder-1', kind: 'folder' }],
};

describe('cloud sessions under a tree node', () => {
  it('lists a session under the node that started it, and not in the Cloud section', () => {
    const folder = renderToStaticMarkup(createElement(CloudFolderRows, { ...props, nodeId: 'folder-1', depth: 1 }));
    expect(folder).toContain('fix-ab12');
    expect(folder).not.toContain('old-task');

    const section = renderToStaticMarkup(createElement(CloudSessionsSection, props));
    expect(section).toContain('Cloud khác (1)');
    expect(section).not.toContain('fix-ab12');
  });

  it('shows no Cloud section at all when every session sits under a node', () => {
    const placed = { ...props, folders: { 'danh/fix-ab12': 'folder-1', 'danh/old-task': 'folder-1' } };
    expect(renderToStaticMarkup(createElement(CloudSessionsSection, placed))).toBe('');
  });

  it('shows a failed create under the node that asked for it, not at the foot of the tree', () => {
    const failed = { ...props, error: 'May da du 3 viec', request: { engine: 'omp' as const, token: 1, nodeId: 'folder-1' } };
    expect(renderToStaticMarkup(createElement(CloudFolderRows, { ...failed, nodeId: 'folder-1', depth: 1 }))).toContain('May da du 3 viec');
    expect(renderToStaticMarkup(createElement(CloudSessionsSection, failed))).not.toContain('May da du 3 viec');
  });

  it('keeps a failed create at the foot of the tree when the node that asked is gone', () => {
    const failed = { ...props, nodes: [], error: 'May da du 3 viec', request: { engine: 'omp' as const, token: 1, nodeId: 'folder-1' } };
    expect(renderToStaticMarkup(createElement(CloudSessionsSection, failed))).toContain('May da du 3 viec');
  });

  it('keeps the loose list closed until it is opened', () => {
    const section = renderToStaticMarkup(createElement(CloudSessionsSection, props));
    expect(section).toContain('aria-expanded="false"');
    expect(section).not.toContain('old-task');
  });

  it('renders nothing under a node that started no cloud session', () => {
    expect(renderToStaticMarkup(createElement(CloudFolderRows, { ...props, nodeId: 'folder-2', depth: 1 }))).toBe('');
  });

  it('falls back to the Cloud section once the node that started a session is gone', () => {
    const section = renderToStaticMarkup(createElement(CloudSessionsSection, { ...props, nodes: [] }));
    expect(section).toContain('Cloud khác (2)');
  });
});
