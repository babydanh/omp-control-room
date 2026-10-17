import * as path from 'node:path';

import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { buildAssetCache } from '../../server/src/assetReload.js';
import {
  COMPANY_OMP_BRIDGE_FILENAME,
  COMPANY_PTY_HOST_FILENAME,
} from '../../server/src/company/constants.js';
import { openWorkspaceCompany } from '../../server/src/company/workspaceCompanyHost.js';
import { PixelAgentsServer } from '../../server/src/server.js';

/**
 * A real Company owner process: the same `openWorkspaceCompany` the packaged CLI
 * and the VS Code extension compose, over the real PTY helper and the real OMP
 * bridge. Only the model-producing OMP itself is a fixture.
 */
async function main(): Promise<void> {
  const workspacePath = process.argv[2];
  if (!workspacePath) throw new Error('company-host requires an isolated workspace path');
  const root = path.resolve(__dirname, '../..');
  const dist = path.join(root, 'dist');
  const assetCache = await buildAssetCache(dist, []);
  const store = new AgentStateStore();
  const server = new PixelAgentsServer();
  const company = await openWorkspaceCompany({
    workspacePath,
    helperPath: path.join(dist, COMPANY_PTY_HOST_FILENAME),
    extensionPath: path.join(dist, COMPANY_OMP_BRIDGE_FILENAME),
    runnerCommand: {
      file: process.execPath,
      args: [path.join(root, 'e2e', 'fixtures', 'mock-omp-company.cjs')],
    },
    onMessage: (message) => store.broadcast(message as unknown as Record<string, unknown>),
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await company.dispose();
      } finally {
        await server.stop();
        store.dispose();
      }
    })();
    return closing;
  };
  const shutdown = (): void => {
    void close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[company-e2e-shutdown]', error);
        process.exit(1);
      },
    );
  };
  try {
    const config = await server.start({
      store,
      embedded: false,
      host: '127.0.0.1',
      port: 0,
      staticDir: path.join(dist, 'webview'),
      assetCache,
      getCompany: () => company.services,
      isCompanyExecutionAllowed: () => closing === undefined,
    });
    process.stdout.write(
      `[company-e2e-ready] ${JSON.stringify({
        url: `http://127.0.0.1:${config.port}/?token=${config.token}`,
      })}\n`,
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);
    process.once('message', (message: unknown) => {
      if (message === 'shutdown') shutdown();
    });
    process.once('disconnect', shutdown);
  } catch (error) {
    await close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error('[company-e2e-startup]', error);
  process.exit(1);
});