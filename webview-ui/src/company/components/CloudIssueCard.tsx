import { useState } from 'react';

import type { BoardCloudIssue } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import { useCommandDialog } from '../useCommandDialog.js';
import { useNow } from '../useNow.js';
import { cloudIssueLabel } from '../workItemView.js';
import { CompanyButton } from './CompanyButton.js';
import { FolderTag } from './FolderTag.js';

const CLOSE_FALLBACK = 'Không đóng được Issue này.';

export function CloudIssueCard({ card, index, client }: { card: BoardCloudIssue; index: number; client: CompanyClient }) {
  const { issue } = card;
  const now = useNow();
  const command = useCommandDialog(client);
  // Closing is a GitHub write: the first click only asks.
  const [confirming, setConfirming] = useState(false);
  const branch = `omp/issue-${issue.issue}`;

  function close(): void {
    setConfirming(false);
    void command.run(client.closeCloudIssue(card.workspacePath, issue.issue), CLOSE_FALLBACK);
  }

  return (
    <article
      data-testid="cloud-issue-card"
      data-flight-key={`cloud:${issue.issue}`}
      data-lane="cloud"
      data-index={index}
      title={`${issue.title} · ${issue.repo ?? 'repo chưa rõ'}`}
      className="company-card flex w-full flex-col gap-1 p-2 text-left"
    >
      <span className="flex min-w-0 items-center justify-between gap-2 text-2xs text-text-muted">
        <span className="shrink-0 tabular-nums">Issue #{issue.issue}</span>
        <span className="truncate">{cloudIssueLabel(issue, now)}</span>
      </span>
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text hover:underline"
      >
        {issue.title}
      </a>
      {issue.repo && <span className="truncate text-2xs text-text-muted">Repo: {issue.repo}</span>}
      <span className="break-all text-2xs text-text-muted">git fetch origin {branch}</span>
      {card.folder !== null && <FolderTag identity={card.folder} />}
      {confirming ? (
        <span className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted">
          Đóng Issue trên GitHub? Nhánh {branch} vẫn giữ.
          <CompanyButton size="sm" className="text-danger" data-testid="cloud-issue-close-confirm" onClick={close}>
            Đóng
          </CompanyButton>
          <CompanyButton size="sm" onClick={() => setConfirming(false)}>
            Thôi
          </CompanyButton>
        </span>
      ) : (
        <CompanyButton
          size="sm"
          className="self-start"
          data-testid="cloud-issue-close"
          disabled={command.pending}
          onClick={() => setConfirming(true)}
        >
          {command.pending ? 'Đang đóng…' : 'Đóng Issue'}
        </CompanyButton>
      )}
      {command.notice !== null && (
        <span role="alert" className="text-2xs text-warning">
          {command.notice}
        </span>
      )}
    </article>
  );
}
