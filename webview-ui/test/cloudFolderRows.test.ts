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
  folderIds: new Set(['folder-1']),
};

describe('cloud sessions under a tree node', () => {
  it('lists a session under the node that started it, and not in the Cloud section', () => {
    const folder = renderToStaticMarkup(createElement(CloudFolderRows, { ...props, nodeId: 'folder-1', depth: 1 }));
    expect(folder).toContain('fix-ab12');
    expect(folder).not.toContain('old-task');

    const section = renderToStaticMarkup(createElement(CloudSessionsSection, props));
    expect(section).toContain('Cloud (1)');
    expect(section).toContain('old-task');
    expect(section).not.toContain('fix-ab12');
  });

  it('renders nothing under a node that started no cloud session', () => {
    expect(renderToStaticMarkup(createElement(CloudFolderRows, { ...props, nodeId: 'folder-2', depth: 1 }))).toBe('');
  });

  it('falls back to the Cloud section once the node that started a session is gone', () => {
    const section = renderToStaticMarkup(createElement(CloudSessionsSection, { ...props, folderIds: new Set<string>() }));
    expect(section).toContain('Cloud (2)');
    expect(section).toContain('fix-ab12');
  });
});
