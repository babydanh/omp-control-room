/**
 * QuestionPanel: answer what the company is actually blocked on.
 *
 * The options, the recommended marker and the multi-select rule come from the
 * Question the server sent, not from anything guessed here. Approval questions
 * carry a decision as well as a selection, and "reject" is a first-class answer
 * rather than a cancellation: a rejected action stops, and the panel says so.
 *
 * Nothing here decides anything locally. Submitting builds the wire answer,
 * sends it with the question's `runEpoch` (and its action digest, when it has
 * one), and the question disappears when the server resolves it -- not when this
 * component feels like hiding it.
 */

import { useState } from 'react';

import type { Question, QuestionAnswerInput } from '../../../../core/src/company.js';
import { newRequestId } from '../companyMessages.js';
import {
  buildQuestionAnswers,
  emptySelection,
  isQuestionAnswered,
  questionHeadline,
  type QuestionSelection,
} from '../questionAnswers.js';
import { type QuestionProvenance, questionProvenanceNote } from '../questionProvenance.js';
import { CompanyButton } from './CompanyButton.js';

export interface QuestionPanelProps {
  question: Question;
  onAnswer: (input: QuestionAnswerInput) => void;
  /** Who wrote this question's words. Rendered above them, never applied to them. */
  provenance?: QuestionProvenance;
}

function PromptRow({
  prompt,
  selection,
  onChange,
}: {
  prompt: Question['questions'][number];
  selection: QuestionSelection;
  onChange: (next: QuestionSelection) => void;
}) {
  const picked = selection[prompt.id] ?? { indices: [], text: '' };
  const toggle = (index: number) => {
    const has = picked.indices.includes(index);
    const indices = prompt.multi
      ? has
        ? picked.indices.filter((entry) => entry !== index)
        : [...picked.indices, index]
      : has
        ? []
        : [index];
    onChange({ ...selection, [prompt.id]: { ...picked, indices } });
  };

  return (
    <fieldset className="mb-3 p-2">
      <legend className="px-2 text-sm text-text">{prompt.question}</legend>
      {prompt.options.map((option, index) => {
        const checked = picked.indices.includes(index);
        return (
          <label
            key={option.label}
            className={`flex cursor-pointer items-start gap-2 rounded-(--company-radius-sm) px-2 py-1 text-sm ${checked ? 'company-selected' : 'hover:bg-hover'}`}
          >
            <input
              type={prompt.multi ? 'checkbox' : 'radio'}
              checked={checked}
              onChange={() => toggle(index)}
              className="mt-1"
            />
            <span className="text-text">
              {option.label}
              {prompt.recommended === index && (
                <span className="ml-2 text-2xs text-accent-bright">khuyến nghị</span>
              )}
              {option.description && (
                <span className="block text-2xs text-text-muted">{option.description}</span>
              )}
            </span>
          </label>
        );
      })}
      <label className="mt-2 flex flex-col gap-1 text-2xs text-text-muted">
        Hoặc tự nhập câu trả lời của bạn
        <textarea
          value={picked.text}
          onChange={(event) =>
            onChange({ ...selection, [prompt.id]: { ...picked, text: event.target.value } })
          }
          rows={2}
          className="w-full rounded-(--company-radius-sm) bg-raised p-1 text-sm text-text"
        />
      </label>
    </fieldset>
  );
}

/**
 * One line describing how a question ended.
 *
 * `answer` is a Record keyed by PROMPT id, not a single answer — reading it as
 * one type-checks only because the field is loosely typed and then renders an
 * empty summary. Each prompt's own options label its selection, so the text
 * reads as the answer a person gave rather than as indices.
 */
function resolvedSummary(question: QuestionPanelProps['question']): string {
  if (question.answer === undefined) return 'Đã rút lại trước khi được trả lời.';
  const record = question.answer as {
    answers?: Record<string, { selectedIndices: number[]; text?: string }>;
  };
  const parts: string[] = [];
  for (const prompt of question.questions) {
    const given = record.answers?.[prompt.id];
    if (given === undefined) continue;
    const labels = given.selectedIndices.map(
      (index: number) => prompt.options[index]?.label ?? `lựa chọn ${index + 1}`,
    );
    const text = given.text === undefined || given.text === '' ? undefined : given.text;
    if (labels.length > 0 || text !== undefined) {
      parts.push(text === undefined ? labels.join(', ') : `${labels.join(', ')} ${text}`);
    }
  }
  // Recorded, but nothing we can name: saying "withdrawn" here would invent a
  // reason nobody recorded.
  if (parts.length === 0) return 'Đã ghi nhận câu trả lời.';
  return `Đã trả lời: ${parts.join(' · ')}`;
}

export function QuestionPanel({ question, onAnswer, provenance }: QuestionPanelProps) {
  const [selection, setSelection] = useState<QuestionSelection>(emptySelection);
  const answers = buildQuestionAnswers(question, selection);
  const ready = isQuestionAnswered(question, selection);

  const submit = (decision?: 'approve_once' | 'reject') =>
    onAnswer({
      requestId: newRequestId(),
      questionId: question.id,
      runEpoch: question.runEpoch,
      actionDigest: question.actionDigest,
      answers,
      decision,
    });

  return (
    <section
      aria-label={questionHeadline(question)}
      data-testid="question-panel"
      className="rounded-(--company-radius-md) bg-warning/12 p-3"
    >
      <h3 className="mb-2 text-sm text-warning">{questionHeadline(question)}</h3>
      {provenance !== undefined && (
        <p className="mb-2 text-2xs text-warning" data-testid="question-provenance">
          {questionProvenanceNote(provenance)}
        </p>
      )}
      {/* A resolved question is history: it must show what was asked and what
          was recorded, not a form. Printing the raw status enum back read as
          "Answered — answered." and hid both the question and the answer. */}
      {question.status !== 'pending' ? (
        <div className="flex flex-col gap-2">
          {question.questions.map((prompt) => (
            <div key={prompt.id} className="rounded-(--company-radius-md) bg-raised p-2">
              <p className="text-xs text-text">{prompt.question}</p>
              {prompt.options.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-2xs text-text-muted">
                  {prompt.options.map((option, optionIndex) => (
                    <li key={`${prompt.id}-${optionIndex}`}>{option.label}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="text-xs text-text-muted">{resolvedSummary(question)}</p>
        </div>
      ) : (
        <>
          {question.questions.map((prompt) => (
            <PromptRow
              key={prompt.id}
              prompt={prompt}
              selection={selection}
              onChange={setSelection}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {question.kind === 'approval' ? (
              <>
                <CompanyButton
                  size="sm"
                  variant="accent"
                  disabled={!ready}
                  onClick={() => submit('approve_once')}
                >
                  Duyệt một lần
                </CompanyButton>
                <CompanyButton size="sm" onClick={() => submit('reject')}>
                  Từ chối
                </CompanyButton>
              </>
            ) : (
              <CompanyButton size="sm" variant="accent" disabled={!ready} onClick={() => submit()}>
                Gửi câu trả lời
              </CompanyButton>
            )}
          </div>
          {question.actionDigest && (
            <p className="mt-2 text-2xs text-text-muted">
              Câu trả lời này áp dụng đúng cho những gì đang hiển thị; thay đổi bất kỳ thứ gì khác
              sẽ phải hỏi lại.
            </p>
          )}
        </>
      )}
    </section>
  );
}
