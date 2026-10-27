import { randomUUID } from 'node:crypto';

import type { SubmitPromptInput } from '../../../core/src/company.js';
import type { ProjectPrepareScript, ProjectSettingsValues } from '../../../core/src/messages.js';
import type { CompanyCoordinator } from '../company/companyCoordinator.js';
import { isInsideRepo } from '../company/workItems/workItemScheduler.js';
import type { HerdrLink } from '../herdr/herdrLink.js';
import type { ProcessRunner } from '../ledger/processRunner.js';
import type { ProjectSessionServices } from './newSession.js';

type SessionCoordinator = Pick<CompanyCoordinator, 'openNewChat' | 'submitPrompt' | 'sessionForNative' | 'snapshot' | 'controlSession'>;

/** How a board chat with no process comes back: a parked or paused one resumes, a stopped or crashed one restarts. */
const REOPEN_ACTION: Readonly<Record<string, 'resume' | 'restart'>> = { parked: 'resume', paused: 'resume', stopped: 'restart', crashed: 'restart' };

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface ProjectSessionRuntimeOptions {
  readonly coordinatorFor: (folder: string) => Promise<SessionCoordinator>;
  /** The board's folders, open or not: a board chat lives in one of them. */
  readonly boardFolders: () => readonly string[];
  /** Opens Claude and agy as interactive agents in herdr, where the user watches and types. */
  readonly herdr: Pick<HerdrLink, 'startAgent' | 'snapshot'>;
  readonly runProcess: ProcessRunner;
  readonly effectiveSettings: (nodeId: string) => Promise<ProjectSettingsValues>;
}

export function createPrepareWorktree(input: {
  readonly effectivePrepareFor: (folder: string) => Promise<ProjectPrepareScript | undefined>;
  readonly runProcess: ProcessRunner;
}): (args: { readonly folder: string; readonly repo: string; readonly worktree: string }) => Promise<void> {
  return async ({ folder, worktree }) => {
    const script = await input.effectivePrepareFor(folder);
    if (script === undefined) return;
    const [file, ...args] = script.argv;
    if (file === undefined) throw new Error('Script chuẩn bị worktree đang trống.');
    const result = await input.runProcess(file, args, {
      cwd: worktree,
      timeoutMs: script.timeoutMs,
      okCodes: [0],
      maxBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    if (!result.ok) {
      const detail = result.timedOut ? 'đã hết thời gian' : result.stderr.trim() || `mã ${result.code ?? 1}`;
      throw new Error(detail);
    }
  };
}
/** Adapt the real folder runtimes to the small Project session service surface. */
export function createProjectSessionRuntime(options: ProjectSessionRuntimeOptions): ProjectSessionServices {
  return {
    effectiveSettings: options.effectiveSettings,
    async runGit(file, argv, cwd, timeoutMs) {
      const result = await options.runProcess(file, argv, {
        cwd,
        timeoutMs: timeoutMs || DEFAULT_GIT_TIMEOUT_MS,
        okCodes: [0],
        maxBytes: MAX_PROCESS_OUTPUT_BYTES,
      });
      return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    async runSetupScript(argv, cwd, timeoutMs) {
      const [file, ...args] = argv;
      if (file === undefined) return { code: 1, stderr: 'Lệnh chuẩn bị worktree đang trống.' };
      const result = await options.runProcess(file, args, {
        cwd,
        timeoutMs,
        okCodes: [0],
        maxBytes: MAX_PROCESS_OUTPUT_BYTES,
      });
      return { code: result.code ?? 1, stderr: result.stderr };
    },
    async openChat({ folder, cwd, prompt }) {
      const coordinator = await options.coordinatorFor(folder);
      const sessionId = await coordinator.openNewChat({ cwd, role: 'chat' });
      // No first prompt: the chat opens empty and the user types in its terminal.
      if (prompt.trim() === '') return sessionId;
      const input: SubmitPromptInput = {
        requestId: randomUUID(),
        text: prompt,
        targetSessionId: sessionId,
        delivery: 'prompt',
        mode: 'chat',
      };
      await coordinator.submitPrompt(input);
      return sessionId;
    },
    async startAgent({ cwd, kind, name, args, prompt }) {
      const text = prompt.trim();
      return options.herdr.startAgent({
        cwd,
        kind,
        name,
        ...(args === undefined ? {} : { args }),
        ...(text === '' ? {} : { prompt: text }),
      });
    },
    async reopenBoardChat({ nativeSessionId, cwd, prompt }) {
      // Folders nest (a repo and a worktree beside it may both be board folders): only the one whose
      // board ran this session can reopen it, and missing it would start a second process on its file.
      for (const folder of options.boardFolders().filter((candidate) => isInsideRepo(cwd, candidate))) {
        const coordinator = await options.coordinatorFor(folder);
        const sessionId = coordinator.sessionForNative?.(nativeSessionId) ?? null;
        const session = coordinator.snapshot().sessions.find((candidate) => candidate.id === sessionId);
        if (sessionId === null || session === undefined) continue;
        const action = REOPEN_ACTION[session.status];
        if (action !== undefined) await coordinator.controlSession(sessionId, action, session.runEpoch);
        const text = prompt.trim();
        if (text !== '') {
          await coordinator.submitPrompt({ requestId: randomUUID(), text, targetSessionId: sessionId, delivery: 'prompt', mode: 'chat' });
        }
        return { folder, sessionId };
      }
      return undefined;
    },
    findAgent(name) {
      const agent = options.herdr.snapshot().agents.find((entry) => entry.name === name);
      return agent === undefined ? undefined : { paneId: agent.paneId, cwd: agent.cwd ?? '' };
    },
  };
}
