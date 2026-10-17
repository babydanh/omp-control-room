/**
 * questionAnswers: turning what the user picked into the wire answer.
 *
 * Two checks happen here rather than in the component, because they are the
 * ones that must not drift between surfaces:
 *
 *  - An index is only sent when it still addresses one of the question's own
 *    options. The Question may have been re-asked with different options since
 *    the panel rendered, and an index that no longer means anything is dropped
 *    rather than forwarded to be interpreted as some other option.
 *  - Free text is only sent as `isOther` when the question actually offers a
 *    "something else" path (any question accepts custom text) and the user
 *    typed something. An empty text field is not an answer.
 */

import type { Question, QuestionAnswer } from '../../../core/src/company.js';

export interface QuestionSelection {
  [promptId: string]: { indices: number[]; text: string };
}

export function emptySelection(): QuestionSelection {
  return {};
}

export function buildQuestionAnswers(
  question: Question,
  selection: QuestionSelection,
): Record<string, QuestionAnswer> {
  const answers: Record<string, QuestionAnswer> = {};
  for (const prompt of question.questions) {
    const picked = selection[prompt.id];
    if (!picked) continue;
    const indices = picked.indices.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < prompt.options.length,
    );
    const text = picked.text.trim();
    answers[prompt.id] = {
      selectedIndices: indices,
      ...(text.length === 0 ? {} : { text }),
      isOther: text.length > 0,
    };
  }
  return answers;
}

/**
 * Whether every prompt has an answer. A prompt with no options is answered by
 * its free text alone; anything else needs a selection or text.
 */
export function isQuestionAnswered(question: Question, answers: QuestionSelection): boolean {
  return question.questions.every((prompt) => {
    const picked = answers[prompt.id];
    if (!picked) return false;
    return picked.indices.length > 0 || picked.text.trim().length > 0;
  });
}

/** Short label for the panel header, without dumping every option. */
export function questionHeadline(question: Question): string {
  const KIND_LABEL: Record<Question['kind'], string> = {
    clarification: 'Làm rõ',
    technical_choice: 'Lựa chọn kỹ thuật',
    approval: 'Phê duyệt',
  };
  return `${KIND_LABEL[question.kind]}: ${question.title}`;
}
