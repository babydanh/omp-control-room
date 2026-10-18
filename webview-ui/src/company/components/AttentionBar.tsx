/**
 * AttentionBar: what is waiting on the user, above everything else.
 *
 * A Contract awaiting approval and a pending question are the only two things
 * that stop the company until the user acts, so they get one line each that
 * opens them in the detail pane. Nothing is decided from here.
 */

import type { Contract, Question } from '../../../../core/src/company.js';

export interface AttentionBarProps {
  contract: Contract | null;
  questions: readonly Question[];
  onOpenContract: () => void;
  onOpenQuestion: (questionId: string) => void;
}

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-[5px] border border-warning bg-bg-dark px-2 py-1 text-left text-2xs text-text hover:border-accent';

export function AttentionBar({
  contract,
  questions,
  onOpenContract,
  onOpenQuestion,
}: AttentionBarProps) {
  if (contract === null && questions.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-2 border-b border-border px-3 py-2"
      data-testid="attention-bar"
    >
      {contract && (
        <button type="button" className={ITEM_CLASS} onClick={onOpenContract}>
          <span className="text-warning">Chờ duyệt</span>
          {contract.code} · {contract.title ?? 'kế hoạch'} · bản {contract.revision}
        </button>
      )}
      {questions.map((question) => (
        <button
          key={question.id}
          type="button"
          className={ITEM_CLASS}
          onClick={() => onOpenQuestion(question.id)}
        >
          <span className="text-warning">Câu hỏi</span>
          {question.title}
        </button>
      ))}
    </div>
  );
}
