/**
 * Fixture data for the ledger view, for development without a running ledger.
 *
 * `applyLedgerFixture(store)` swaps the store's transport for a local responder and
 * connects. The responder answers every ledger request from this file after a short
 * delay, so every tab, panel, diff and send path runs through the real reducer. In a
 * DEV build, `window.applyLedgerFixture()` calls it from the browser console. Reload
 * the page to return to the real connection.
 */

import type {
  ClientMessage,
  LedgerSession,
  LedgerTimeline,
  LedgerTimelineBucket,
  LedgerTimelineLane,
  LedgerView,
} from '../../../../core/src/messages.js';
import { type LedgerWindow, parseLedgerTimestamp } from './ledgerFormat.js';
import type { LedgerSend, LedgerStore } from './ledgerStore.js';
import { TIMELINE_BUCKET_COUNT } from './ledgerTimelineLayout.js';

/** The fixture's "now". Every timestamp in the fixture is relative to it. */
export const LEDGER_FIXTURE_NOW = '2026-10-18 10:30:00';

const FIXTURE_LATENCY_MS = 120;

const SESSION_WORKER = '9f2c3a7d61e04b8a8c5d2e1f0a7b6c51';
const SESSION_QA = 'b7e10c44a2d9411f8e3c6a5d0b9e8f72';
const SESSION_BILLING = 'c3a9e7f1b2d84a06';
const SESSION_SEARCH = 'e5f0a2c8d9b14e73a0c6d8e2f4b7a1c9';
const SESSION_AUTH = '4d8e1f0a9c2b47e6a1f3d5c7b9e0a2d4';
const SESSION_LEAD = 'a0d7b3e9f4c1462d8b5e7a3c1f9d6e20';

const BOARD = 'D:/Code/omp-board';
const BOARD_LEDGER = 'D:/Code/omp-board-feat-ledger';
const BOARD_AUTH = 'D:/Code/omp-board-fix-auth';
const BOARD_SPIKE = 'D:/Code/omp-board-old-spike';
const API = 'D:/Code/api-server';
const API_BILLING = 'D:/Code/api-server-billing';
const API_SEARCH = 'D:/Code/api-server-search';
const MOBILE = 'D:/Code/mobile-app';
const MOBILE_RELEASE = 'D:/Code/mobile-app-release';

const SESSIONS: LedgerSession[] = [
  {
    sessionId: SESSION_WORKER,
    agentKind: 'omp',
    agentName: 'Thợ UI',
    parentId: null,
    open: true,
    live: true,
    state: 'busy',
    cwd: BOARD_LEDGER,
    repo: BOARD,
    checkout: BOARD_LEDGER,
    branch: 'feat/ledger-graph',
    lastIntent: 'Viết LedgerView và đồ thị nhánh',
    lastCallAt: '2026-10-18 10:29:41',
    calls5m: 18,
    calls30m: 64,
    spamming: false,
    spamReason: null,
    pid: 18244,
  },
  {
    sessionId: SESSION_QA,
    agentKind: 'omp',
    agentName: 'QA',
    parentId: SESSION_WORKER,
    open: true,
    live: true,
    state: 'idle',
    cwd: BOARD_LEDGER,
    repo: BOARD,
    checkout: BOARD_LEDGER,
    branch: 'feat/ledger-graph',
    lastIntent: 'Chạy kiểm thử ledger',
    lastCallAt: '2026-10-18 10:28:02',
    calls5m: 4,
    calls30m: 11,
    spamming: false,
    spamReason: null,
    pid: 18310,
  },
  {
    sessionId: SESSION_BILLING,
    agentKind: 'omp',
    agentName: 'Thợ billing',
    parentId: null,
    open: true,
    live: true,
    state: 'busy',
    cwd: API_BILLING,
    repo: API,
    checkout: API_BILLING,
    branch: 'feat/billing',
    lastIntent: 'Sửa lệnh bash lặp mãi',
    lastCallAt: '2026-10-18 10:30:12',
    calls5m: 74,
    calls30m: 130,
    spamming: true,
    spamReason: 'Gọi 74 lần trong 5 phút (ngưỡng 60)',
    pid: 19020,
  },
  {
    sessionId: SESSION_SEARCH,
    agentKind: 'omp',
    agentName: 'QA API',
    parentId: null,
    open: true,
    live: false,
    state: 'idle',
    cwd: API_SEARCH,
    repo: API,
    checkout: API_SEARCH,
    branch: 'feat/search-index',
    lastIntent: 'Đọc tài liệu chỉ mục',
    lastCallAt: '2026-10-18 09:58:44',
    calls5m: 0,
    calls30m: 6,
    spamming: false,
    spamReason: null,
    pid: null,
  },
  {
    sessionId: SESSION_AUTH,
    agentKind: 'omp',
    agentName: 'Thợ auth',
    parentId: null,
    open: false,
    live: false,
    state: 'ended',
    cwd: BOARD_AUTH,
    repo: BOARD,
    checkout: BOARD_AUTH,
    branch: 'fix/auth-token',
    lastIntent: 'Sửa token hết hạn',
    lastCallAt: '2026-10-18 08:14:20',
    calls5m: 0,
    calls30m: 0,
    spamming: false,
    spamReason: null,
    pid: null,
  },
  {
    sessionId: SESSION_LEAD,
    agentKind: 'omp',
    agentName: 'Trưởng nhóm',
    parentId: null,
    open: true,
    live: true,
    state: 'busy',
    cwd: BOARD,
    repo: BOARD,
    checkout: BOARD,
    branch: 'main',
    lastIntent: 'Chỉnh sửa tài liệu trực tiếp trên main',
    lastCallAt: '2026-10-18 10:25:55',
    calls5m: 9,
    calls30m: 22,
    spamming: false,
    spamReason: null,
    pid: 17702,
  },
];

/** Diffs keyed by `${worktree}|${path}`. Paths not listed report "no change". */
interface FixtureDiff {
  diff: string;
  truncated: boolean;
}

const FIXTURE_DIFFS: Readonly<Partial<Record<string, FixtureDiff>>> = {
  [`${BOARD_LEDGER}|webview-ui/src/company/ledger/LedgerView.tsx`]: {
    truncated: false,
    diff: [
      '+export function LedgerView(props: LedgerViewProps): ReactElement {',
      '+  const state = useLedgerState(ledgerStore);',
      '+  const [tab, setTab] = useState<LedgerTab>("graph");',
      '+  return (',
      '+    <section data-testid="ledger-view" aria-label="Cây git">',
      '+    </section>',
      '+  );',
      '+}',
    ].join('\n'),
  },
  [`${BOARD_LEDGER}|webview-ui/src/company/companyState.ts`]: {
    truncated: false,
    diff: [
      '@@ -86,7 +86,9 @@ export function selectSession(state, id) {',
      '-  const next = applySelection(state, id);',
      '+  const next = applySelection(state, id);',
      '+  notifyListeners(next);',
      '   return next;',
    ].join('\n'),
  },
  [`${BOARD_LEDGER}|webview-ui/src/company/BoardTopBar.tsx`]: {
    truncated: true,
    diff: [
      '@@ -40,6 +40,12 @@ export function BoardTopBar(props: BoardTopBarProps) {',
      '+        <button type="button" aria-pressed={ledgerOpen} onClick={onToggleLedger}>',
      '+          Cây git',
      '+        </button>',
    ].join('\n'),
  },
};

const TIMELINE_SEEDS: Readonly<
  Partial<Record<string, { seed: number; dense: boolean; file: string }>>
> = {
  [SESSION_WORKER]: { seed: 1, dense: false, file: 'webview-ui/src/company/ledger/LedgerView.tsx' },
  [SESSION_QA]: { seed: 4, dense: false, file: 'webview-ui/test/ledgerStore.test.ts' },
  [SESSION_BILLING]: { seed: 2, dense: true, file: 'src/billing/invoice.ts' },
  [SESSION_SEARCH]: { seed: 7, dense: false, file: 'src/search/index.ts' },
  [SESSION_LEAD]: { seed: 5, dense: false, file: 'README.md' },
};

const SHARED_FILES: LedgerTimeline['shared'] = [
  {
    a: SESSION_WORKER,
    b: SESSION_LEAD,
    path: 'webview-ui/src/company/BoardTopBar.tsx',
    bucket: 50,
  },
  { a: SESSION_BILLING, b: SESSION_SEARCH, path: 'src/db/schema.ts', bucket: 44 },
  {
    a: SESSION_WORKER,
    b: SESSION_QA,
    path: 'webview-ui/src/company/ledger/LedgerView.tsx',
    bucket: 55,
  },
];

function toLedgerTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The fixture board: three repos, a spamming session, partial and failed overlap scans. */
export function ledgerFixtureView(): LedgerView {
  return {
    generatedAt: LEDGER_FIXTURE_NOW,
    database: { state: 'ok' },
    repos: [
      {
        repo: BOARD,
        name: 'omp-board',
        worktrees: [
          {
            path: BOARD,
            name: 'omp-board',
            branch: 'main',
            head: 'a1f3c9e',
            isMain: true,
            ahead: 0,
            behind: 0,
            dirtyCount: 2,
            dirtyFiles: [
              { path: 'README.md', status: ' M' },
              { path: 'docs/notes.md', status: '??' },
            ],
            merged: false,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Gộp feat/herdr-inline',
            lastCommitAt: '2026-10-18 09:12:40',
            sessionIds: [SESSION_LEAD],
          },
          {
            path: BOARD_LEDGER,
            name: 'feat-ledger',
            branch: 'feat/ledger-graph',
            head: '7c02d4a',
            isMain: false,
            ahead: 14,
            behind: 3,
            dirtyCount: 4,
            dirtyFiles: [
              { path: 'webview-ui/src/company/ledger/LedgerView.tsx', status: '??' },
              { path: 'webview-ui/src/company/companyState.ts', status: ' M' },
              { path: 'webview-ui/src/company/BoardTopBar.tsx', status: ' M' },
              { path: 'webview-ui/src/company/ledger/ledgerStore.ts', status: '??' },
            ],
            merged: false,
            hasUpstream: true,
            unpushed: 2,
            lastCommitSubject: 'Thêm đồ thị nhánh cây git',
            lastCommitAt: '2026-10-18 10:21:05',
            sessionIds: [SESSION_WORKER, SESSION_QA],
          },
          {
            path: BOARD_AUTH,
            name: 'fix-auth',
            branch: 'fix/auth-token',
            head: '3b9d1e6',
            isMain: false,
            ahead: 2,
            behind: 9,
            dirtyCount: 0,
            dirtyFiles: [],
            merged: false,
            hasUpstream: false,
            unpushed: null,
            lastCommitSubject: 'Sửa token hết hạn',
            lastCommitAt: '2026-10-18 08:14:20',
            sessionIds: [SESSION_AUTH],
          },
          {
            path: BOARD_SPIKE,
            name: 'old-spike',
            branch: 'spike/old-canvas',
            head: '90ad2f1',
            isMain: false,
            ahead: 0,
            behind: 40,
            dirtyCount: 0,
            dirtyFiles: [],
            merged: true,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Thử nghiệm canvas',
            lastCommitAt: '2026-09-30 16:40:00',
            sessionIds: [],
          },
        ],
      },
      {
        repo: API,
        name: 'api-server',
        worktrees: [
          {
            path: API,
            name: 'api-server',
            branch: 'main',
            head: 'e0c4b77',
            isMain: true,
            ahead: 0,
            behind: 0,
            dirtyCount: 0,
            dirtyFiles: [],
            merged: false,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Thêm chỉ mục tìm kiếm',
            lastCommitAt: '2026-10-17 17:02:19',
            sessionIds: [],
          },
          {
            path: API_BILLING,
            name: 'api-server-billing',
            branch: 'feat/billing',
            head: '5ad8e03',
            isMain: false,
            ahead: 5,
            behind: 1,
            dirtyCount: 1,
            dirtyFiles: [{ path: 'src/billing/invoice.ts', status: 'M' }],
            merged: false,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Tính thuế hóa đơn',
            lastCommitAt: '2026-10-18 10:19:52',
            sessionIds: [SESSION_BILLING],
          },
          {
            path: API_SEARCH,
            name: 'api-server-search',
            branch: 'feat/search-index',
            head: 'c81f0b2',
            isMain: false,
            ahead: 3,
            behind: 0,
            dirtyCount: 0,
            dirtyFiles: [],
            merged: false,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Thêm bảng chỉ mục',
            lastCommitAt: '2026-10-18 09:58:44',
            sessionIds: [SESSION_SEARCH],
          },
        ],
      },
      {
        repo: MOBILE,
        name: 'mobile-app',
        worktrees: [
          {
            path: MOBILE,
            name: 'mobile-app',
            branch: 'main',
            head: '4e7a9d0',
            isMain: true,
            ahead: 0,
            behind: 0,
            dirtyCount: 0,
            dirtyFiles: [],
            merged: false,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Cập nhật ảnh biểu tượng',
            lastCommitAt: '2026-10-15 11:30:00',
            sessionIds: [],
          },
          {
            path: MOBILE_RELEASE,
            name: 'mobile-app-release',
            branch: 'release/2.4',
            head: '0d6b8c2',
            isMain: false,
            ahead: 0,
            behind: 2,
            dirtyCount: 0,
            dirtyFiles: [],
            merged: false,
            hasUpstream: true,
            unpushed: 0,
            lastCommitSubject: 'Chuẩn bị bản 2.4',
            lastCommitAt: '2026-10-14 15:05:00',
            sessionIds: [],
            gitError: 'git status thất bại: tồn tại index.lock',
          },
        ],
      },
    ],
    unscannedFolders: ['V:/Duancanhan/Project_QuanLyGiaiDau', 'D:/Scratch/prototype'],
    sessions: SESSIONS,
    pending: [
      {
        checkout: BOARD_AUTH,
        sessionId: SESSION_AUTH,
        branch: 'fix/auth-token',
        dirty: 0,
        unpushed: 2,
        notInMain: 2,
        hasRemote: false,
        ts: '2026-10-18 08:20:03',
      },
      {
        checkout: API_SEARCH,
        sessionId: SESSION_SEARCH,
        branch: 'feat/search-index',
        dirty: 0,
        unpushed: 0,
        notInMain: 3,
        hasRemote: true,
        ts: '2026-10-18 09:59:10',
      },
    ],
    notices: [
      {
        id: 41,
        ts: '2026-10-18 10:02:11',
        toSession: SESSION_WORKER,
        fromSession: SESSION_LEAD,
        relKey: 'rebase-main',
        content: 'Main vừa nhận commit mới, nhớ rebase trước khi gộp.',
      },
      {
        id: 42,
        ts: '2026-10-18 10:18:40',
        toSession: SESSION_BILLING,
        fromSession: null,
        relKey: null,
        content: 'Hệ thống: phát hiện 74 lệnh trong 5 phút, vui lòng dừng vòng lặp.',
      },
      {
        id: 43,
        ts: '2026-10-18 10:25:30',
        toSession: SESSION_QA,
        fromSession: SESSION_WORKER,
        relKey: null,
        content: 'Chạy lại bộ kiểm thử cây git sau khi sửa LedgerTreeTab, báo lại kết quả cho tôi.',
      },
    ],
    mainWrites: [
      {
        sessionId: SESSION_LEAD,
        ts: '2026-10-18 10:25:55',
        tool: 'edit',
        path: 'README.md',
        intent: 'Cập nhật hướng dẫn',
      },
      {
        sessionId: SESSION_LEAD,
        ts: '2026-10-18 09:40:02',
        tool: 'write',
        path: 'CHANGELOG.md',
        intent: null,
      },
    ],
    overlaps: [
      {
        repo: BOARD,
        state: 'done',
        startedAt: '2026-10-18 10:20:00',
        finishedAt: '2026-10-18 10:20:14',
        base: 'origin/main',
        lanes: 3,
        pairs: [
          {
            a: BOARD_LEDGER,
            b: BOARD_AUTH,
            aLabel: 'feat-ledger',
            bLabel: 'fix-auth',
            conflicts: [
              {
                file: 'webview-ui/src/company/companyState.ts',
                hunks: [
                  {
                    line: 88,
                    symbol: 'selectSession',
                    ours: ['  const next = applySelection(state, id);', '  return next;'],
                    theirs: ['  const next = selectOne(state, id);', '  notify(next);'],
                  },
                  {
                    line: 210,
                    symbol: 'closeDrawer',
                    ours: ['  return { ...state, drawer: null };'],
                    theirs: ['  return { ...state, drawer: null, herdr: null };'],
                  },
                ],
              },
              {
                file: 'server/src/ledger/view.ts',
                hunks: [
                  {
                    line: 41,
                    symbol: 'buildView',
                    ours: ['  const repos = await scanRepos(roots);'],
                    theirs: ['  const repos = await scanRepos(roots, { depth: 2 });'],
                  },
                ],
              },
            ],
            auto: ['README.md'],
          },
        ],
        main: [
          {
            lane: BOARD_LEDGER,
            label: 'feat-ledger',
            conflicts: [
              {
                file: 'webview-ui/src/company/BoardTopBar.tsx',
                hunks: [
                  {
                    line: 52,
                    symbol: 'BoardTopBar',
                    ours: ['      <nav aria-label="Thanh công cụ">'],
                    theirs: ['      <nav aria-label="Thanh điều hướng">'],
                  },
                ],
              },
            ],
          },
        ],
        pending: [],
        complete: true,
        error: null,
      },
      {
        repo: API,
        state: 'partial',
        startedAt: '2026-10-18 10:21:00',
        finishedAt: null,
        base: 'origin/main',
        lanes: 4,
        pairs: [
          {
            a: API_BILLING,
            b: API_SEARCH,
            aLabel: 'feat/billing',
            bLabel: 'feat/search-index',
            conflicts: [
              {
                file: 'src/db/schema.ts',
                hunks: [
                  {
                    line: 17,
                    symbol: 'invoices',
                    ours: ['  total: numeric(12, 2),'],
                    theirs: ['  total: numeric(14, 2),'],
                  },
                ],
              },
            ],
            auto: [],
          },
        ],
        main: [],
        pending: [API_SEARCH],
        complete: false,
        error: null,
      },
      {
        repo: MOBILE,
        state: 'error',
        startedAt: '2026-10-18 10:22:00',
        finishedAt: '2026-10-18 10:22:02',
        base: null,
        lanes: 0,
        pairs: [],
        main: [],
        pending: [],
        complete: false,
        error: 'overlap.py: không tìm thấy nhánh origin/main',
      },
    ],
    spamRule: {
      windowMinutes: 5,
      callsPerWindow: 60,
      sameIntentPerWindow: 12,
      lookbackMinutes: 30,
    },
  };
}

function fixtureBuckets(
  seed: number,
  dense: boolean,
  intent: string,
  file: string,
): LedgerTimelineBucket[] {
  const buckets: LedgerTimelineBucket[] = [];
  for (let index = 0; index < TIMELINE_BUCKET_COUNT; index += 1) {
    const roll = (index * 7 + seed * 3) % 11;
    if (!dense && roll > 4) continue;
    const scale = dense ? 6 : 1;
    const bucket: LedgerTimelineBucket = {
      index,
      edit: (roll % 3) * scale,
      bash: (roll % 2) * scale + (dense ? 1 : 0),
      read: ((roll + 1) % 4) * (dense ? 2 : 1),
      other: roll === 10 ? 1 : 0,
      intents: roll < 2 ? [intent] : [],
      files: roll % 3 === 0 ? [file] : [],
    };
    if (bucket.edit + bucket.bash + bucket.read + bucket.other > 0) buckets.push(bucket);
  }
  return buckets;
}

function fixtureLane(session: LedgerSession, buckets: LedgerTimelineBucket[]): LedgerTimelineLane {
  const total = buckets.reduce(
    (sum, bucket) => sum + bucket.edit + bucket.bash + bucket.read + bucket.other,
    0,
  );
  return {
    sessionId: session.sessionId,
    agentKind: session.agentKind,
    agentName: session.agentName,
    repo: session.repo,
    spamming: session.spamming,
    spamReason: session.spamReason,
    total,
    buckets,
  };
}

/** The fixture timeline for one window. Sessions with no activity in the window have no lane. */
export function ledgerFixtureTimeline(windowMinutes: LedgerWindow): LedgerTimeline {
  const endMs = parseLedgerTimestamp(LEDGER_FIXTURE_NOW) ?? 0;
  const lanes: LedgerTimelineLane[] = [];
  for (const session of SESSIONS) {
    const plan = TIMELINE_SEEDS[session.sessionId];
    if (plan === undefined) continue;
    const buckets = fixtureBuckets(plan.seed, plan.dense, session.lastIntent ?? '', plan.file);
    lanes.push(fixtureLane(session, buckets));
  }
  return {
    windowMinutes,
    bucketSeconds: windowMinutes,
    startedAt: toLedgerTimestamp(endMs - windowMinutes * 60_000),
    endedAt: LEDGER_FIXTURE_NOW,
    lanes,
    shared: SHARED_FILES,
    truncated: false,
  };
}

function answerFixtureRequest(store: LedgerStore, message: ClientMessage): void {
  switch (message.type) {
    case 'ledgerViewRequest':
      store.accept({
        type: 'ledgerSnapshot',
        requestId: message.requestId,
        view: ledgerFixtureView(),
      });
      return;
    case 'ledgerTimelineRequest':
      store.accept({
        type: 'ledgerTimeline',
        requestId: message.requestId,
        timeline: ledgerFixtureTimeline(message.windowMinutes),
      });
      return;
    case 'ledgerFileDiffRequest': {
      const inRepo = ledgerFixtureView().repos.some((repo) =>
        repo.worktrees.some((worktree) => worktree.path === message.worktree),
      );
      if (!inRepo) {
        store.accept({
          type: 'ledgerFileDiff',
          requestId: message.requestId,
          ok: false,
          worktree: message.worktree,
          path: message.path,
          diff: '',
          truncated: false,
          reason: 'Đường dẫn không nằm trong danh sách đã quét.',
        });
        return;
      }
      const found = FIXTURE_DIFFS[`${message.worktree}|${message.path}`];
      store.accept({
        type: 'ledgerFileDiff',
        requestId: message.requestId,
        ok: true,
        worktree: message.worktree,
        path: message.path,
        diff: found?.diff ?? '',
        truncated: found?.truncated ?? false,
        reason: found === undefined ? 'Không có thay đổi so với HEAD.' : undefined,
      });
      return;
    }
    case 'ledgerSendMessage': {
      const session = SESSIONS.find((item) => item.sessionId === message.sessionId);
      if (session === undefined) {
        store.accept({
          type: 'ledgerCommandResult',
          requestId: message.requestId,
          ok: false,
          reason: 'Không tìm thấy phiên.',
        });
        return;
      }
      if (!session.live) {
        store.accept({
          type: 'ledgerCommandResult',
          requestId: message.requestId,
          ok: false,
          reason: 'Phiên không còn chạy, tin nhắn không được gửi.',
        });
        return;
      }
      store.accept({
        type: 'ledgerCommandResult',
        requestId: message.requestId,
        ok: true,
        delivered: [message.sessionId],
      });
      return;
    }
  }
}

/**
 * Points the store at the local responder and connects. The probe then answers with
 * the fixture view, which makes the ledger available in the board's top bar.
 */
export function applyLedgerFixture(store: LedgerStore): void {
  const send: LedgerSend = (message) => {
    setTimeout(() => answerFixtureRequest(store, message), FIXTURE_LATENCY_MS);
  };
  store.setSend(send);
  store.connect();
  store.requestTimeline(60);
}
