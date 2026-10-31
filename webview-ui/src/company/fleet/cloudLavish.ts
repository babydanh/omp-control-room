/** What `cloud-giao` calls the repositories it checks out: `/data/home/wt/<repo>-<slug>` or, for all of them, `/data/home/wt/<slug>/<repo>`. */
const TASK_REPOS = ['backend', 'web', 'app'] as const;
const WORKTREE_BASE = '/data/home/wt/';

interface LavishFile {
  readonly key: string;
  readonly file: string;
}

/** The machine's Lavish files that live in the worktrees of one cloud task (its tmux session is named after the slug). */
export function lavishOfSession<T extends LavishFile>(lavish: readonly T[] | undefined, session: string): T[] {
  return (lavish ?? []).filter((entry) => {
    if (!entry.file.startsWith(WORKTREE_BASE)) return false;
    const top = entry.file.slice(WORKTREE_BASE.length).split('/')[0] ?? '';
    return top === session || TASK_REPOS.some((repo) => top === `${repo}-${session}`);
  });
}

/** A blank tab opened inside the click (so it is not blocked as a popup), pointed at Lavish once the port is forwarded. */
export function openPendingTab() {
  const tab = window.open('about:blank', '_blank');
  if (!tab) return null;
  tab.opener = null;
  tab.document.title = 'Đang nối tới Lavish…';
  tab.document.body.textContent = 'Đang nối cổng tới máy cloud (máy ngủ thì mất 1–2 phút)…';
  return { navigate: (url: string) => tab.location.replace(url), close: () => tab.close() };
}
