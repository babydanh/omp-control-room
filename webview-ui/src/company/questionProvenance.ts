/**
 * questionProvenance: who wrote the words in a Question.
 *
 * A Question's text is DATA — the model authored the title, the prompt and the
 * option labels, in whatever language it chose. The webview must not rewrite
 * it: translating it would answer a question the user was never asked, and the
 * e2e suite drives the flow through the fixture's own English wording.
 *
 * But a scripted dialog rendered inside an otherwise Vietnamese panel reads as
 * untranslated UI, and that is exactly the mistake this module exists to stop.
 * So the panel says where its words came from instead of leaving the reader to
 * guess.
 *
 * The signal is the fixture's own self-announcement. `mock-omp-company` -- the
 * E2E stand-in for the native OMP process -- prefixes every line it prints
 * with its own name, and those lines reach the webview as the session's public
 * output. That is the only provenance the wire carries: a Question has no
 * `source` field, and the fixture is not ours to edit. Detecting a value we can
 * actually observe beats guessing, and beats saying nothing.
 */

import type { TextStreamView } from './companyState.js';

/** The name the E2E fixture signs every line of public output with. */
export const SCRIPTED_FIXTURE_MARKER = 'mock-omp-company';

export type QuestionProvenance = 'fixture' | 'model';

/**
 * Where a question's words came from. The evidence is the SESSION's public
 * output, because that is where the author identifies itself: a session whose
 * output names the scripted fixture produced them, and anything else is
 * treated as a real reading, because there is nothing else to treat it as.
 */
export function questionProvenance(stream: TextStreamView | undefined): QuestionProvenance {
  return stream?.tail.includes(SCRIPTED_FIXTURE_MARKER) ? 'fixture' : 'model';
}

/**
 * The line the panel prints above a question's own words. It never rewrites
 * them — it names the author, so the reader knows whether the language they are
 * looking at is the product's or the model's.
 */
export function questionProvenanceNote(provenance: QuestionProvenance): string {
  if (provenance === 'fixture') {
    return (
      'Nội dung câu hỏi dưới đây đến từ fixture kịch bản E2E (mock-omp-company), ' +
      'KHÔNG phải từ OMP thật. Văn bản tiếng Anh bên dưới là nội dung kịch bản.'
    );
  }
  return (
    'Nội dung câu hỏi do mô hình tự sinh theo ngôn ngữ của nó, ' +
    'không phải văn bản giao diện của sản phẩm.'
  );
}
