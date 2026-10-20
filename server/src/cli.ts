#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as path from 'path';

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import { browserReaperEnabled, createBrowserReaper } from './company/browserReaper.js';
import { createBrowserReaperHostDeps } from './company/browserReaperProbes.js';
import { resolveNativeLaunch } from './company/companyNativeLaunch.js';
import {
  COMPANY_DEFAULT_WORKSPACE_PATH,
  COMPANY_OMP_BRIDGE_FILENAME,
  COMPANY_PTY_HOST_FILENAME,
} from './company/constants.js';
import { FolderScope } from './company/folderScope.js';
import { createUsageReader } from './company/usagePage.js';
import { openWorkspaceCompany } from './company/workspaceCompanyHost.js';
import { CompanyWorkspaceRegistry } from './company/workspaceRegistry.js';
import {
  forgetRecentCompanyWorkspace,
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readCompanyFolderNames,
  readConfig,
  readRecentCompanyWorkspaces,
  rememberRecentCompanyWorkspace,
  setCompanyFolderName,
} from './configPersistence.js';
import {
  MAX_PORT,
  MIN_PORT,
  SERVER_JSON_DIR,
  STANDALONE_TOKEN_FILE_NAME,
  TERMINAL_DISABLED_BY_FLAG_REASON,
  WILDCARD_HOSTNAMES,
} from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { createHerdrLink } from './herdr/herdrLink.js';
import { createLedgerService } from './ledger/ledgerRuntime.js';
import { runProcess } from './ledger/processRunner.js';
import { createProjectRuntime } from './projects/projectRuntime.js';
import { claudeProvider, copyHookScript, hookProviderById } from './providers/index.js';
import { PixelAgentsServer } from './server.js';
import { PtySessionManager } from './terminal/ptySessionManager.js';
import { isLoopbackHost, normalizeHostname, redactTokenQuery } from './wsAuth.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  /** Workspace whose Company runtime this server exposes. */
  workspace: string;
  /** False when --no-terminal was passed: the office only watches agents; the
   *  browser can neither launch them nor attach to their terminals. */
  terminal: boolean;
  /** --allowed-host names (repeatable): extra Host names, beyond loopback and a
   *  specific --host, that a tokened browser session is privileged under --
   *  typically a reverse proxy's public name. See wsAuth.privilegedHostnames. */
  allowedHosts: string[];
  /** --rotate-token: replace the persisted server token before starting. */
  rotateToken: boolean;
  /** False when --no-browser-reaper was passed: idle omp headless browsers are left running. */
  browserReaper: boolean;
  /** --hide-token: print the start URL with its token redacted, for output that goes to a log file. */
  hideToken: boolean;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    host: '127.0.0.1',
    workspace: COMPANY_DEFAULT_WORKSPACE_PATH,
    terminal: true,
    browserReaper: true,
    allowedHosts: [],
    rotateToken: false,
    hideToken: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--workspace') {
      const workspace = argv[i + 1];
      if (!workspace?.trim() || workspace.startsWith('--')) {
        throw new CliArgsError('Missing value for --workspace: expected a directory path.');
      }
      args.workspace = workspace;
      i++;
    } else if (argv[i] === '--allowed-host') {
      const raw = argv[i + 1];
      const name = normalizeHostname(raw);
      if (name === null || (WILDCARD_HOSTNAMES as readonly string[]).includes(name)) {
        throw new CliArgsError(
          raw === undefined
            ? 'Missing value for --allowed-host: expected a host name, e.g. my-mac.tailnet.ts.net.'
            : `Invalid --allowed-host "${raw}": expected a host name, e.g. my-mac.tailnet.ts.net.`,
        );
      }
      args.allowedHosts.push(raw as string);
      i++;
    } else if (argv[i] === '--rotate-token') {
      args.rotateToken = true;
    } else if (argv[i] === '--no-terminal') {
      args.terminal = false;
    } else if (argv[i] === '--no-browser-reaper') {
      args.browserReaper = false;
    } else if (argv[i] === '--hide-token') {
      args.hideToken = true;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --workspace <path>    Company workspace (default: ${COMPANY_DEFAULT_WORKSPACE_PATH})
  --allowed-host <name> Also accept the tokened URL at this host name, e.g. a
                        reverse proxy's (Tailscale Serve). Repeatable. Without
                        it, only localhost and a specific --host are privileged
  --rotate-token        Replace the server token. Every URL that carried the
                        old one (bookmarks, other devices) stops working
  --no-terminal         Disable the embedded terminal (watch agents only; no
                        launching or attaching from the browser)
  --no-browser-reaper   Leave idle omp headless browsers running (default: stop
                        those with no open page for 10 minutes)
  --hide-token          Print the start URL without its token (the token stays in
                        ~/.pixel-agents/standalone-token), for output kept in a log
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Hooks consent ─────────────────────────────────────────────
// First-run consent is asked IN THE APP, not here: the server sends a
// hooksConsentRequest to privileged (tokened) connections during the
// webviewReady handshake (clientMessageHandler.ts), and the browser renders
// the dialog — the same UX the VS Code webview shows. The CLI itself never
// prompts; a headless run just starts without hooks until consent is granted
// through the UI. The one exception that needs no dialog is the silent-grant
// migration below (our hooks already installed by a pre-consent version).

/**
 * Copy the bundled hook script into ~/.pixel-agents/hooks/, reporting failure.
 *
 * Callers run this BEFORE installing the settings.json entries and abort when
 * it returns false: an entry whose command points at a missing script makes
 * Claude Code spawn a dead `node` process for every event, which is strictly
 * worse than no hooks at all.
 */
function copyHookScriptOrReport(packageRoot: string, context = ''): boolean {
  if (copyHookScript(packageRoot)) return true;
  console.error(`[Pixel Agents] Hooks NOT installed${context}: hook script missing.`);
  return false;
}

// ── Terminal status reporting ─────────────────────────────────

/**
 * Log one clear line about terminal availability, plus a security warning when
 * a working terminal is bound to a non-loopback address.
 *
 * The reason string matters: the most likely failure (npm >=11.16 gating
 * node-pty's install scripts, so it imports but can't spawn) is invisible
 * otherwise -- the user would just see a + Agent button that does nothing.
 *
 * Opting out with --no-terminal is not a failure, so it gets a quiet
 * confirmation instead of the reinstall hint, and skips the non-loopback shell
 * warning (there is no shell surface to warn about).
 */
function reportTerminalStatus(
  ptyManager: PtySessionManager,
  host: string,
  enabledByFlag: boolean,
): void {
  if (!enabledByFlag) {
    console.log(
      '[Pixel Agents] Terminal disabled (--no-terminal): agents can be watched but not launched from the browser.',
    );
    return;
  }

  if (!ptyManager.isAvailable()) {
    console.warn(
      `[Pixel Agents] Terminal disabled: ${ptyManager.unavailableReason()}\n` +
        `[Pixel Agents] The office still works; you just can't launch agents from the browser.\n` +
        `[Pixel Agents] To enable it, reinstall so the optional PTY module is present.`,
    );
    return;
  }

  console.log(`[Pixel Agents] Terminal enabled (via ${ptyManager.moduleId()})`);

  if (!isLoopbackHost(host)) {
    console.warn(
      `[Pixel Agents] WARNING: bound to ${host}, not loopback. The terminal is a shell:\n` +
        `[Pixel Agents] anyone who can reach this port AND has the auth token can run commands\n` +
        `[Pixel Agents] as you, and plain HTTP sends that token unencrypted. Behind a reverse\n` +
        `[Pixel Agents] proxy (e.g. Tailscale Serve), keep --host 127.0.0.1 and pass the proxy's\n` +
        `[Pixel Agents] name with --allowed-host instead.`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();
  const runtime = new AgentRuntime(store, claudeProvider);
  // Open Company folders, canonicalised: herdr, sleeping panes and the ledger tag each item with the folder that holds it.
  const folderScope = new FolderScope();
  // herdr is an optional side channel: when its socket is absent the board
  // shows herdr as unavailable and the rest of the server runs unchanged.
  const herdr = createHerdrLink({ workspaceFor: (cwd) => folderScope.folderOf(cwd) });
  herdr.onAgents((message) => store.broadcast(message as unknown as Record<string, unknown>));
  herdr.onScreen((message) => store.broadcast(message as unknown as Record<string, unknown>));
  // Stops omp's idle headless browsers. --no-browser-reaper or
  // PIXEL_AGENTS_BROWSER_REAPER=0 turns it off: then nothing is listed, probed or stopped.
  const browserReaper = createBrowserReaper({
    enabled: browserReaperEnabled(args.browserReaper, process.env),
    deps: createBrowserReaperHostDeps({
      // The company host's own OMP resolver, given the same bundled paths as the company below.
      resolveCommand: () =>
        resolveNativeLaunch({
          extensionPath: path.join(distRoot, COMPANY_OMP_BRIDGE_FILENAME),
          helperPath: path.join(distRoot, COMPANY_PTY_HOST_FILENAME),
        }).command,
      cwd: args.workspace,
      publish: (message) => store.broadcast(message as unknown as Record<string, unknown>),
      log: (message) => console.log(`[Pixel Agents] ${message}`),
      warn: (message) => console.warn(`[Pixel Agents] ${message}`),
    }),
  });

  // Usage page reads run the company's bundled OMP on demand only: no timers, no polling.
  const usage = createUsageReader({
    command: () =>
      resolveNativeLaunch({
        extensionPath: path.join(distRoot, COMPANY_OMP_BRIDGE_FILENAME),
        helperPath: path.join(distRoot, COMPANY_PTY_HOST_FILENAME),
      }).command,
    cwd: args.workspace,
    logger: (message) => console.log(`[Pixel Agents] ${message}`),
  });

  // Company folders: the initial one opens below; the board can open more and
  // switch between them. Only the active folder's traffic reaches the board.
  const company = new CompanyWorkspaceRegistry({
    broadcast: (message) => store.broadcast(message as unknown as Record<string, unknown>),
    openHost: openWorkspaceCompany,
    hostDefaults: {
      helperPath: path.join(distRoot, COMPANY_PTY_HOST_FILENAME),
      extensionPath: path.join(distRoot, COMPANY_OMP_BRIDGE_FILENAME),
      herdr,
      ledger: { overlapScans: () => ledger.overlapScans(), watched: () => ledger.watched() },
      prepareWorktree: (input) => projects.prepareWorktree(input),
    },
    recents: {
      read: readRecentCompanyWorkspaces,
      remember: rememberRecentCompanyWorkspace,
      forget: forgetRecentCompanyWorkspace,
    },
    names: { read: readCompanyFolderNames, set: setCompanyFolderName },
    onFoldersChanged: (openPaths) => {
      void folderScope.setFolders(openPaths).then(() => {
        void herdr.rescope();
        ledger.rescope();
      });
      // A newly opened folder's scheduler starts on its own file; give it the inherited values.
      projects.refreshSettings().catch((error: unknown) => {
        console.warn(`[Pixel Agents] Project settings refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  // Cây git board: scans the repos seen in recent activity plus the open company folders.
  const ledger = createLedgerService({
    extraRepoPaths: () =>
      company
        .entries()
        .filter((entry) => entry.open)
        .map((entry) => entry.path),
    workspaceFor: (target) => folderScope.folderOf(target),
  });
  // Project tree (sidebar): one store and the services its commands run on.
  const projects = createProjectRuntime({
    company,
    ledger,
    runProcess,
  });
  // Terminals for agents this server launches. Construction is cheap -- the
  // native module is resolved (and probed) lazily on first use, so a user who
  // never opens a terminal never pays for it. With --no-terminal, a disabled
  // manager reports "unavailable" through the same plumbing (availability
  // broadcast, session route, launcher), so nothing downstream special-cases it.
  const ptyManager = args.terminal
    ? new PtySessionManager()
    : PtySessionManager.disabled(TERMINAL_DISABLED_BY_FLAG_REASON);
  let acceptingCompany = true;
  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    acceptingCompany = false;
    disposal = (async () => {
      try {
        // Kill child terminals before the runtime tears their agents down, and
        // wait for them: exiting now would cancel the SIGKILL escalation and
        // leave a child that ignores SIGHUP orphaned on a dead server.
        await ptyManager.disposeAll();
        await company.dispose();
      } finally {
        ledger.dispose();
        runtime.dispose();
        herdr.stop();
        browserReaper.stop();
        await server.stop();
        store.dispose();
      }
    })();
    return disposal;
  };

  try {
    try {
      await company.open(args.workspace);
      console.log(`[Pixel Agents] Company workspace: ${args.workspace}`);
    } catch (error) {
      // Legacy observation remains usable; Company commands fail closed while
      // the workspace or native runtime prerequisite is unavailable.
      console.error('[Pixel Agents] Company workspace unavailable:', error);
    }

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall the named provider's
    // hooks when the user toggles in the UI (or answers the consent ask).
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (providerId: string, enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      const provider = hookProviderById(providerId);
      if (!provider) return; // unknown id: nothing to install into
      if (enabled) {
        // An explicit toggle in the UI IS the consent to modify the
        // provider's settings file. The bundled claude-hook.js script belongs
        // to the Claude provider alone; another provider's install must
        // neither copy it nor be blocked by it.
        grantHooksConsent(provider.id);
        if (
          provider.id === claudeProvider.id &&
          !copyHookScriptOrReport(packageRoot, ' (user toggle)')
        ) {
          return;
        }
        try {
          await provider.installHooks(
            `http://127.0.0.1:${currentConfig.port}`,
            currentConfig.token,
          );
        } catch (err) {
          console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        console.log('[Pixel Agents] Hooks installed (user toggle)');
      } else {
        try {
          await provider.uninstallHooks();
          console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
        } catch (err) {
          console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[Pixel Agents] Assets reloaded (external directory change)');
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
      getCompany: () => (acceptingCompany ? company.activeServices() : null),
      isCompanyExecutionAllowed: () => acceptingCompany,
      workspaces: company,
      ledger,
      projects: { store: projects.store, services: projects.services },
      herdr,
      browserReaper,
      usage,
      ptyManager,
      allowedHosts: args.allowedHosts,
      rotateToken: args.rotateToken,
    });
    currentConfig = { port: config.port, token: config.token };
    herdr.start();
    browserReaper.start();
    // Background: the first board open then finds the git scans cached instead of waiting on them.
    projects.warm().catch((error: unknown) => {
      console.warn(`[Pixel Agents] Project tree warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (args.rotateToken) {
      console.log(
        '[Pixel Agents] Server token rotated: URLs carrying the old token no longer grant access. Open the new URL below on each device.',
      );
    }

    reportTerminalStatus(ptyManager, args.host, args.terminal);

    // Sync runtime refs with persisted settings BEFORE first scan tick. The
    // runtime's single hooksEnabled ref follows the Claude provider until the
    // scanners grow per-provider awareness alongside the Settings UI.
    runtime.hooksEnabled.current = getHooksEnabled(claudeProvider.id);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so — gated on the
    // one-time consent to modify ~/.claude/settings.json.
    if (runtime.hooksEnabled.current) {
      let consent = getHooksConsent(claudeProvider.id) === 'granted';
      if (!consent && (await claudeProvider.areHooksInstalled())) {
        // Our hooks are already installed and already firing — a pre-consent
        // version put them there. Grant and continue with NO prompt: the
        // install below is the 14 -> 12 migration, and it only ever REDUCES
        // scope (it drops UserPromptSubmit and TaskCreated, the two events that
        // forwarded prompt text and were consumed by nothing). Asking would buy
        // this user no protection they do not already have, so they are not
        // asked. A fresh install still is, in full — in the browser UI, when a
        // tokened client connects (clientMessageHandler's webviewReady).
        grantHooksConsent(claudeProvider.id);
        consent = true;
      }
      if (!consent) {
        console.log(
          '[Pixel Agents] Hooks not installed: modifying ~/.claude/settings.json needs one-time approval — open the URL below to review and approve it.',
        );
      } else if (copyHookScriptOrReport(packageRoot)) {
        try {
          await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          console.log('[Pixel Agents] Hooks installed');
        } catch (err) {
          console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // Without this line, a persisted hooks-off makes startup skip the entire
      // consent/install flow with zero output — indistinguishable from a bug.
      console.log(
        '[Pixel Agents] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.',
      );
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // The URL the operator opens has to be REACHABLE (a wildcard bind address
    // is a bind target, not an address you can browse to — `--host 0.0.0.0`
    // used to print a dead `http://0.0.0.0:PORT`) and has to carry the token,
    // which is what makes the session it loads privileged enough to approve a
    // hook install (see standaloneTokenValid in httpServer.ts). Under `--host
    // 0.0.0.0` the office stays readable from the LAN at this machine's own
    // address; only the consent-bearing toggle needs the token.
    const displayHost =
      args.host === '0.0.0.0' || args.host === '::' || args.host === '' ? '127.0.0.1' : args.host;
    // The operator opens this URL, so it carries the token. --hide-token is for output kept
    // on disk (a launcher's log file): the token is redacted, like the request logs
    // (see redactTokenQuery), and the line says where the persisted token lives.
    const url = `http://${displayHost}:${config.port}/?token=${config.token}`;
    const shownUrl = args.hideToken
      ? `${redactTokenQuery(url)} (token: ~/${SERVER_JSON_DIR}/${STANDALONE_TOKEN_FILE_NAME})`
      : url;
    console.log(`\n  Pixel Agents server running at ${shownUrl}\n`);

    // ── Graceful shutdown ──
    let shuttingDown = false;
    async function shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down...');
      void dispose().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('[Pixel Agents] Company shutdown failed:', error);
          process.exit(1);
        },
      );
    }

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (err) {
    console.error('Failed to start server:', err);
    await dispose().catch((error: unknown) => {
      console.error('[Pixel Agents] Shutdown after startup failure:', error);
    });
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
