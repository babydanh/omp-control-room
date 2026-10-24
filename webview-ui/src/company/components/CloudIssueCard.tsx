import type { BoardCloudIssue } from '../boardView.js';
import { useNow } from '../useNow.js';
import { cloudIssueLabel } from '../workItemView.js';
import { FolderTag } from './FolderTag.js';

export function CloudIssueCard({ card, index }: { card: BoardCloudIssue; index: number }) {
  const { issue } = card;
  const now = useNow();
  const branch = `omp/issue-${issue.issue}`;
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      data-testid="cloud-issue-card"
      data-flight-key={`cloud:${issue.issue}`}
      data-lane="cloud"
      data-index={index}
      title={`${issue.title} · ${issue.repo ?? 'repo chưa rõ'}`}
      className="company-card flex w-full flex-col gap-1 p-2 text-left hover:bg-hover"
    >
      <span className="flex min-w-0 items-center justify-between gap-2 text-2xs text-text-muted">
        <span className="shrink-0 tabular-nums">Issue #{issue.issue}</span>
        <span className="truncate">{cloudIssueLabel(issue, now)}</span>
      </span>
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        {issue.title}
      </span>
      {issue.repo && <span className="truncate text-2xs text-text-muted">Repo: {issue.repo}</span>}
      <span className="break-all text-2xs text-text-muted">git fetch origin {branch}</span>
      {card.folder !== null && <FolderTag identity={card.folder} />}
    </a>
  );
}
