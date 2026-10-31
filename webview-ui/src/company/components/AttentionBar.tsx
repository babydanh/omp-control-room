/**
 * AttentionBar: what is waiting on the user, above everything else.
 *
 * A Contract awaiting approval and a pending question are the only two things
 * that stop the company until the user acts, so they get one line each that
 * opens them in the detail pane. Nothing is decided from here.
 */

import type { Contract, Question } from '../../../../core/src/company.js';
import type { FolderIdentity } from '../folderIdentity.js';
import { FolderTag } from './FolderTag.js';

export interface AttentionBarProps {
  contract: Contract | null;
  questions: readonly Question[];
  /** The folder a contract or question belongs to; null outside all mode. */
  identityOf: (id: string) => FolderIdentity | null;
  onOpenContract: () => void;
  onOpenQuestion: (questionId: string) => void;
}

// One short pill per waiting thing: the label and a clipped title (the full text is the tooltip), so the bar stays a thin strip.
const ITEM_CLASS =
  'touch-target flex min-w-0 max-w-[16rem] cursor-pointer items-center gap-1.5 rounded-full bg-warning/12 px-2.5 py-0.5 text-left text-2xs text-text hover:bg-warning/20';
const TITLE_CLASS = 'min-w-0 truncate';

export function AttentionBar({
  contract,
  questions,
  identityOf,
  onOpenContract,
  onOpenQuestion,
}: AttentionBarProps) {
  if (contract === null && questions.length === 0) return null;
  const contractFolder = contract === null ? null : identityOf(contract.id);
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-1" data-testid="attention-bar">
      {contract && (
        <button
          type="button"
          className={ITEM_CLASS}
          title={`${contract.code} · ${contract.title ?? 'kế hoạch'} · bản ${contract.revision}`}
          onClick={onOpenContract}
        >
          {contractFolder !== null && <FolderTag identity={contractFolder} />}
          <span className="shrink-0 text-warning">Chờ duyệt</span>
          <span className={TITLE_CLASS}>{contract.code}</span>
        </button>
      )}
      {questions.map((question) => {
        const folder = identityOf(question.id);
        return (
          <button
            key={question.id}
            type="button"
            className={ITEM_CLASS}
            title={question.title}
            onClick={() => onOpenQuestion(question.id)}
          >
            {folder !== null && <FolderTag identity={folder} />}
            <span className="shrink-0 text-warning">Câu hỏi</span>
            <span className={TITLE_CLASS}>{question.title}</span>
          </button>
        );
      })}
    </div>
  );
}
