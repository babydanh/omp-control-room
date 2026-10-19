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

const ITEM_CLASS =
  'touch-target flex cursor-pointer items-center gap-2 rounded-full bg-warning/12 px-3 py-1 text-left text-2xs text-text hover:bg-warning/20';

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
    <div className="flex flex-wrap gap-2 px-3 py-2" data-testid="attention-bar">
      {contract && (
        <button type="button" className={ITEM_CLASS} onClick={onOpenContract}>
          {contractFolder !== null && <FolderTag identity={contractFolder} />}
          <span className="text-warning">Chờ duyệt</span>
          {contract.code} · {contract.title ?? 'kế hoạch'} · bản {contract.revision}
        </button>
      )}
      {questions.map((question) => {
        const folder = identityOf(question.id);
        return (
          <button
            key={question.id}
            type="button"
            className={ITEM_CLASS}
            onClick={() => onOpenQuestion(question.id)}
          >
            {folder !== null && <FolderTag identity={folder} />}
            <span className="text-warning">Câu hỏi</span>
            {question.title}
          </button>
        );
      })}
    </div>
  );
}
