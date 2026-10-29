import type {
  FleetMachineSnapshot,
  FleetSnapshotMessage,
  GitGuardReport,
  GitGuardRisk,
  GitGuardWorktree,
} from '../../../../core/src/messages.js';
import { fleetStore } from './fleetClient.js';
import { useFleetState } from './fleetStore.js';
import { classifyWorktreeShelf, type WorktreeShelfCategory } from './worktreeShelf.js';

interface GuardSource {
  readonly machine: string;
  readonly report: GitGuardReport;
  readonly activePaths: readonly string[];
  readonly activeBranches: readonly string[];
  readonly activeTaskSlugs: readonly string[];
}

interface ShelfEntry {
  readonly machine: string;
  readonly repo: string;
  readonly worktree: GitGuardWorktree;
  readonly category: WorktreeShelfCategory;
}

const RISK_LABELS: Record<GitGuardRisk['kind'], string> = {
  unpushed: 'Commit chưa đẩy',
  dirty: 'Tệp chưa lưu vào commit',
  stash: 'Stash đang giữ thay đổi',
  op: 'Git chưa hoàn tất thao tác',
  prunable: 'Worktree đã mất thư mục',
  detached: 'Commit không thuộc nhánh',
};

function sources(snapshot: FleetSnapshotMessage): GuardSource[] {
  return [
    ...(snapshot.localGuard === undefined
      ? []
      : [
          {
            machine: 'local',
            report: snapshot.localGuard,
            activePaths: snapshot.localActivePaths ?? [],
            activeBranches: snapshot.localActiveBranches ?? [],
            activeTaskSlugs: [],
          },
        ]),
    ...snapshot.machines.flatMap((machine) =>
      machine.guard === undefined ? [] : [cloudSource(machine, machine.guard)],
    ),
  ];
}

function cloudSource(machine: FleetMachineSnapshot, report: GitGuardReport): GuardSource {
  return {
    machine: machine.agentId,
    report,
    activePaths: machine.activePaths ?? [],
    activeBranches: machine.activeBranches ?? [],
    activeTaskSlugs: machine.activeTaskSlugs ?? [],
  };
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function scanTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('vi-VN') : value;
}

function reportRisks(report: GitGuardReport, repo: string, path?: string): GitGuardRisk[] {
  return report.risks.filter(
    (risk) =>
      pathKey(risk.repo) === pathKey(repo) &&
      (path === undefined || pathKey(risk.path) === pathKey(path)),
  );
}

function commandSuggestion(risk: GitGuardRisk, worktree?: GitGuardWorktree): string {
  const path = worktree?.path ?? risk.path;
  const quotedPath = `"${path.replaceAll('"', '`"')}"`;
  switch (risk.kind) {
    case 'unpushed':
      return worktree?.branch === null || worktree?.branch === undefined
        ? `git -C ${quotedPath} status -sb`
        : `git -C ${quotedPath} update-ref "refs/backup/local/${worktree.branch}" HEAD`;
    case 'stash':
      return `git -C "${risk.repo.replaceAll('"', '`"')}" stash list`;
    case 'prunable':
      return `git -C "${risk.repo.replaceAll('"', '`"')}" worktree prune`;
    case 'detached':
      return `git -C ${quotedPath} branch --contains HEAD`;
    case 'dirty':
      return `git -C ${quotedPath} status --short --ignored`;
    case 'op':
      return `git -C ${quotedPath} status`;
  }
}

function RiskRows({
  risks,
  worktree,
}: {
  risks: readonly GitGuardRisk[];
  worktree?: GitGuardWorktree;
}) {
  if (risks.length === 0) return null;
  return (
    <ul className="mt-2 space-y-2">
      {risks.map((risk) => (
        <li
          key={`${risk.kind}:${risk.path}`}
          className={`rounded border px-3 py-2 text-sm ${risk.level === 'red' ? 'border-danger/30 bg-danger/12' : 'border-warning/30 bg-warning/10'}`}
        >
          <p className={risk.level === 'red' ? 'text-danger' : 'text-warning'}>
            <strong>
              {risk.level === 'red' ? 'ĐỎ' : 'VÀNG'} · {RISK_LABELS[risk.kind]}
            </strong>{' '}
            — {risk.detail}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Gợi ý: <code className="break-all">{commandSuggestion(risk, worktree)}</code>
          </p>
        </li>
      ))}
    </ul>
  );
}

function MachineRisks({ source }: { source: GuardSource }) {
  const report = source.report;
  const machineRisks = report.risks.length;
  const red = report.risks.filter((risk) => risk.level === 'red').length;
  return (
    <details className="rounded border border-hairline bg-panel">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <strong>{source.machine === 'local' ? 'Máy local' : source.machine}</strong>
        <span className="text-xs text-text-muted">Quét lúc {scanTime(report.scannedAt)}</span>
        <span className="ml-auto text-xs text-text-secondary">{machineRisks} rủi ro</span>
        {red > 0 && (
          <span className="rounded-full bg-danger/12 px-2 text-xs text-danger">{red} đỏ</span>
        )}
      </summary>
      <div className="space-y-2 border-t border-hairline p-3">
        {report.repos.map((repo) => {
          const repoRiskCount = reportRisks(report, repo.repo).length;
          return (
            <details key={repo.repo} className="rounded border border-hairline">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="break-all font-mono">{repo.repo}</span>
                <span className="ml-auto text-xs text-text-muted">
                  {repo.worktrees.length} worktree · {repoRiskCount} rủi ro
                </span>
              </summary>
              <div className="space-y-3 border-t border-hairline p-3">
                {repo.worktrees.map((worktree) => {
                  const risks = reportRisks(report, repo.repo, worktree.path);
                  return (
                    <section
                      key={worktree.path}
                      className="rounded border border-hairline px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <strong className="break-all font-mono text-text">{worktree.path}</strong>
                        <span className="rounded bg-well px-1.5 py-0.5 text-text-secondary">
                          {worktree.branch ?? 'detached'}
                        </span>
                        <span className="text-text-muted">
                          {worktree.unpushed} commit chưa đẩy · {worktree.dirty} tệp đổi ·{' '}
                          {worktree.ignored ?? 'chưa rõ'} tệp bị bỏ qua · idle {worktree.idleDays}{' '}
                          ngày
                        </span>
                        {worktree.unpushed > 0 && (
                          <span className={worktree.backedUp ? 'text-warning' : 'text-danger'}>
                            {worktree.backedUp ? 'đã sao lưu' : 'chưa sao lưu'}
                          </span>
                        )}
                      </div>
                      {worktree.unpushedSubjects.length > 0 && (
                        <p className="mt-1 break-words text-xs text-text-muted">
                          Commit: {worktree.unpushedSubjects.join(' · ')}
                        </p>
                      )}
                      <RiskRows risks={risks} worktree={worktree} />
                    </section>
                  );
                })}
                <RiskRows
                  risks={reportRisks(report, repo.repo).filter(
                    (risk) =>
                      !repo.worktrees.some(
                        (worktree) => pathKey(worktree.path) === pathKey(risk.path),
                      ),
                  )}
                />
              </div>
            </details>
          );
        })}
        {report.repos.length === 0 && (
          <p className="text-sm text-text-muted">Chưa tìm thấy repository.</p>
        )}
      </div>
    </details>
  );
}

function shelfEntries(allSources: readonly GuardSource[]): ShelfEntry[] {
  return allSources.flatMap((source) =>
    source.report.repos.flatMap((repo) =>
      repo.worktrees.map((worktree) => ({
        machine: source.machine,
        repo: repo.repo,
        worktree,
        category: classifyWorktreeShelf(worktree, { ...source, repoPath: repo.repo }),
      })),
    ),
  );
}

const SHELVES: readonly { readonly category: WorktreeShelfCategory; readonly title: string }[] = [
  { category: 'doing', title: 'Đang làm' },
  { category: 'sleeping', title: 'Ngủ' },
  { category: 'trash', title: 'Rác' },
];

function WorktreeShelf({ entries }: { entries: readonly ShelfEntry[] }) {
  return (
    <details className="rounded border border-hairline bg-panel">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
        Kệ worktree · {entries.length}
      </summary>
      <div className="space-y-4 border-t border-hairline p-3">
        <p className="text-xs text-text-muted">
          Rác được tự dọn theo luật an toàn: local qua who.py prune --yes, cloud không dùng --force
          và giữ nhánh.
        </p>
        {SHELVES.map(({ category, title }) => {
          const rows = entries.filter((entry) => entry.category === category);
          return (
            <section key={category} className="space-y-2">
              <h3 className="text-xs font-semibold text-text-secondary">
                {title} · {rows.length}
              </h3>
              {rows.length === 0 ? (
                <p className="text-xs text-text-muted">Không có worktree.</p>
              ) : (
                <ul className="space-y-1">
                  {rows.map(({ machine, repo, worktree }) => (
                    <li
                      key={`${machine}:${worktree.path}`}
                      className="rounded bg-well px-3 py-2 text-xs"
                    >
                      <p className="break-all font-mono text-text">{worktree.path}</p>
                      <p className="mt-1 text-text-muted">
                        {machine} · {repo} · {worktree.branch ?? 'detached'} · idle{' '}
                        {worktree.idleDays} ngày
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </details>
  );
}

export function GuardView() {
  const fleet = useFleetState(fleetStore);
  const snapshot = fleet.snapshot;
  const allSources = snapshot === null ? [] : sources(snapshot);
  const risks = allSources.flatMap((source) => source.report.risks);
  const red = risks.filter((risk) => risk.level === 'red').length;
  const yellow = risks.filter((risk) => risk.level === 'yellow').length;
  const shelf = shelfEntries(allSources);
  const machinesWithoutGuard =
    snapshot?.machines.filter((machine) => machine.guard === undefined) ?? [];

  return (
    <div className="company-shell-page flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-text">Rủi ro mất code</h1>
          <p className="text-xs text-text-muted">
            Local và cloud · tự sao lưu commit chưa đẩy · cập nhật fleet định kỳ.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fleetStore.requestFleet()}
          className="company-btn company-btn-md company-btn-ghost touch-target shrink-0"
        >
          Làm mới
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-2 text-sm" aria-live="polite">
          <span className="rounded-full bg-danger/12 px-2 py-1 text-danger">Đỏ · {red}</span>
          <span className="rounded-full bg-warning/10 px-2 py-1 text-warning">Vàng · {yellow}</span>
        </div>
        {snapshot?.hubError && (
          <p
            role="alert"
            className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            Không lấy được báo cáo từ hub cloud: {snapshot.hubError} Dữ liệu máy local vẫn được hiển
            thị.
          </p>
        )}
        {snapshot === null && fleet.error !== null && (
          <p
            role="alert"
            className="rounded border border-danger/30 bg-danger/12 px-3 py-2 text-sm text-danger"
          >
            {fleet.error}
          </p>
        )}
        {snapshot === null && fleet.latestRequestId !== null && (
          <p role="status" className="text-sm text-text-muted">
            Đang tải báo cáo git guard…
          </p>
        )}
        {snapshot !== null && allSources.length === 0 && (
          <p className="text-sm text-text-muted">Chưa có máy nào gửi báo cáo git guard.</p>
        )}
        {machinesWithoutGuard.length > 0 && (
          <p className="text-xs text-text-muted">
            Chưa nhận được git guard từ:{' '}
            {machinesWithoutGuard.map((machine) => machine.agentId).join(', ')}.
          </p>
        )}
        {snapshot !== null &&
          allSources.map((source) => <MachineRisks key={source.machine} source={source} />)}
        {snapshot !== null && risks.length === 0 && allSources.length > 0 && (
          <p className="text-sm text-status-success">Chưa phát hiện rủi ro mất code.</p>
        )}
        {snapshot !== null && <WorktreeShelf entries={shelf} />}
      </div>
    </div>
  );
}
