/**
 * agentApi: what an agent in a terminal may ask the board, through the `board` command.
 *
 * The caller names itself by its herdr pane id (HERDR_PANE_ID) and its working directory. Three
 * answers: every live session and open work item (`status`), the work items that are the caller's
 * own (`task`), and a progress note written onto one of them (`report`). Routes are bearer-token
 * guarded with the same token the hook endpoint takes (`~/.pixel-agents/server.json`).
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ProjectTreeNode, WorkItem } from '../../../core/src/messages.js';
import type { WorkItemService } from '../company/workItems/workItemService.js';
import { bearerTokenValid } from '../wsAuth.js';

export const AGENT_API_PREFIX = '/api/agent';

/** Longest note `board report` keeps, in characters. */
export const AGENT_NOTE_MAX_CHARS = 2000;

/** Who asks: the herdr pane it runs in, and its working directory. */
export interface AgentCaller {
  readonly paneId?: string;
  readonly cwd?: string;
}

export interface AgentFolder {
  readonly path: string;
  readonly service: Pick<WorkItemService, 'snapshot' | 'note'>;
}

/** One live session as `board status` lists it. */
export interface AgentSessionRow {
  readonly folder: string;
  readonly agent: string;
  readonly state: string;
  readonly title: string;
  readonly cwd: string;
  readonly paneId?: string;
  readonly progress?: ProjectTreeNode['progress'];
}

/** A work item with the folder whose board holds it. */
export interface AgentWorkItem extends WorkItem {
  readonly folder: string;
}

export interface AgentApiDeps {
  readonly token: string;
  sessions(): Promise<AgentSessionRow[]>;
  folders(): AgentFolder[];
}

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Whether one path is the other or lies inside it. */
function sameTree(a: string, b: string): boolean {
  const left = pathKey(a);
  const right = pathKey(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Session rows from a Project tree: each session with the folder it sits under. */
export function sessionRows(nodes: readonly ProjectTreeNode[]): AgentSessionRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const folderOf = (node: ProjectTreeNode): string => {
    for (let parent = node.parentId === undefined ? undefined : byId.get(node.parentId); parent !== undefined; parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId)) {
      if (parent.kind === 'folder') return parent.path ?? parent.name;
    }
    return '';
  };
  return nodes.flatMap((node) => node.kind !== 'session' ? [] : [{
    folder: folderOf(node),
    agent: node.agentKind ?? node.engine ?? '',
    state: node.state ?? '',
    title: node.title || node.name,
    cwd: node.path ?? '',
    ...(node.herdrPaneId === undefined ? {} : { paneId: node.herdrPaneId }),
    ...(node.progress === undefined ? {} : { progress: node.progress }),
  }]);
}

function allItems(folders: readonly AgentFolder[]): AgentWorkItem[] {
  return folders.flatMap((folder) => folder.service.snapshot().items.map((item) => ({ ...item, folder: folder.path })));
}

/** The caller's own items: given to its herdr pane, or worked in a worktree it stands in. */
export function itemsFor(caller: AgentCaller, items: readonly AgentWorkItem[]): AgentWorkItem[] {
  return items.filter((item) => {
    if (caller.paneId !== undefined && item.assignee.kind === 'herdr' && item.assignee.paneId === caller.paneId) return true;
    const worktree = item.worktreeRemoved === true ? undefined : item.worktree?.path;
    return caller.cwd !== undefined && worktree !== undefined && sameTree(worktree, caller.cwd);
  });
}

export type ItemLookup = { readonly ok: true; readonly item: AgentWorkItem } | { readonly ok: false; readonly reason: string };

/** `#12`, `12` or an item id; the caller's own items are searched first, then every board. */
export function findItem(ref: string, caller: AgentCaller, items: readonly AgentWorkItem[]): ItemLookup {
  const trimmed = ref.trim().replace(/^#/, '');
  const matches = (item: AgentWorkItem) => item.id === trimmed || String(item.sequence) === trimmed;
  const own = itemsFor(caller, items).filter(matches);
  const found = own.length > 0 ? own : items.filter(matches);
  if (found.length === 1 && found[0] !== undefined) return { ok: true, item: found[0] };
  if (found.length === 0) return { ok: false, reason: `Không có việc ${ref} trên bảng.` };
  return { ok: false, reason: `Việc ${ref} có ở nhiều thư mục (${found.map((item) => item.folder).join(', ')}): dùng mã việc (id) thay cho số.` };
}

function callerOf(query: Record<string, unknown>): AgentCaller {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const paneId = text(query['pane']);
  const cwd = text(query['cwd']);
  return { ...(paneId === undefined ? {} : { paneId }), ...(cwd === undefined ? {} : { cwd }) };
}

const OPEN: ReadonlySet<WorkItem['status']> = new Set(['queued', 'running', 'needs_input', 'review']);

export function registerAgentRoutes(app: FastifyInstance, deps: AgentApiDeps): void {
  const guard = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!bearerTokenValid(request.headers.authorization, deps.token)) return reply.code(401).send({ error: 'unauthorized' });
    },
  };

  app.get<{ Querystring: Record<string, unknown> }>(`${AGENT_API_PREFIX}/status`, guard, async (request) => {
    const caller = callerOf(request.query);
    const sessions = await deps.sessions();
    const you = sessions.find((session) => session.paneId !== undefined && session.paneId === caller.paneId)
      ?? sessions.find((session) => caller.cwd !== undefined && pathKey(session.cwd) === pathKey(caller.cwd));
    const snapshots = deps.folders().map((folder) => ({ folder, snapshot: folder.service.snapshot() }));
    const items = snapshots.flatMap(({ folder, snapshot }) => snapshot.items.map((item) => ({ ...item, folder: folder.path })));
    return {
      caller,
      ...(you === undefined ? {} : { you }),
      sessions,
      workItems: items.filter((item) => OPEN.has(item.status)),
      // Finished work whose branch has not reached origin/main yet: what is still missing to ship.
      undelivered: items.filter((item) => item.status === 'done' && item.delivery !== undefined && item.delivery.stage !== 'main'),
      cloudIssues: snapshots.flatMap(({ folder, snapshot }) =>
        (snapshot.cloudIssues ?? []).map((issue) => ({ ...issue, folder: folder.path })),
      ),
    };
  });

  app.get<{ Querystring: Record<string, unknown> }>(`${AGENT_API_PREFIX}/task`, guard, async (request) => {
    const caller = callerOf(request.query);
    return { caller, items: itemsFor(caller, allItems(deps.folders())) };
  });

  app.post<{ Body: Record<string, unknown> }>(`${AGENT_API_PREFIX}/report`, guard, async (request, reply) => {
    const body = request.body ?? {};
    const caller = callerOf(body);
    const ref = typeof body['item'] === 'string' ? body['item'] : '';
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (ref === '' || text === '') return reply.code(400).send({ error: 'Cần số việc và nội dung báo cáo.' });
    if (text.length > AGENT_NOTE_MAX_CHARS) return reply.code(400).send({ error: `Báo cáo dài quá ${AGENT_NOTE_MAX_CHARS} ký tự.` });
    const folders = deps.folders();
    const found = findItem(ref, caller, allItems(folders));
    if (!found.ok) return reply.code(404).send({ error: found.reason });
    const folder = folders.find((entry) => entry.path === found.item.folder);
    if (folder === undefined) return reply.code(404).send({ error: `Không có việc ${ref} trên bảng.` });
    await folder.service.note({ requestId: randomUUID(), id: found.item.id, text });
    return { ok: true, item: found.item.sequence, folder: found.item.folder };
  });
}
