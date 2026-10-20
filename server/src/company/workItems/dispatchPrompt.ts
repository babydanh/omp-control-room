/**
 * The prompt an agent receives for one work item: the item's text, a line naming the omp subagent
 * when one is chosen, the safe-work block, and the acceptance line last, as before.
 *
 * Pure: no I/O. The service calls it when an item is saved or requeued, so the prompt an agent gets
 * is the one the item stored.
 */

import { composePrompt } from '../../../../core/src/workItemGraph.js';

/** The safe-work block for an agent that may edit files. Vietnamese, as the board's agents read it. */
export const SAFE_WORK_BLOCK =
  'Luật làm việc: làm trên worktree hoặc nhánh riêng theo luật của repo, không push thẳng lên main. ' +
  'Khi xong, báo lại danh sách file đã sửa, các lệnh đã chạy và mã thoát của từng lệnh.';

/** The safe-work block for a read-only agent: it reports what it read, and edits nothing. */
export const SAFE_READ_ONLY_BLOCK =
  'Việc này chỉ đọc: không sửa file, không push thẳng lên main. Khi xong, báo lại các file đã xem, các lệnh đã chạy và mã thoát của từng lệnh.';

/** The default worker. Naming it adds no subagent line. */
export const DEFAULT_AGENT = 'task';

/** Which engine runs the item. Its subagent line names the engine's own way to run a role. */
export type PromptEngine = 'omp' | 'claude';

/** What a prompt is composed from. `agent` absent means the default worker. */
export interface DispatchPromptParts {
  readonly text: string;
  readonly acceptance?: string;
  readonly agent?: string;
  readonly readOnly: boolean;
  /** Absent means omp, whose subagent line names the omp task tool. */
  readonly engine?: PromptEngine;
}

/**
 * Composes the prompt for one work item. Order: text, the subagent line (only for an agent other
 * than the default), the safe-work block, then "Xong khi: …" as the last line when there is one.
 */
export function composeDispatchPrompt(parts: DispatchPromptParts): string {
  const sections = [parts.text.trim()];
  if (parts.agent !== undefined && parts.agent !== '' && parts.agent !== DEFAULT_AGENT) {
    sections.push(
      parts.engine === 'claude'
        ? `Làm việc này theo vai trò \`${parts.agent}\` trong Claude Code, rồi tổng hợp kết quả và báo lại.`
        : `Làm việc này bằng subagent omp \`${parts.agent}\` (tool task, agent: ${parts.agent}), rồi tổng hợp kết quả và báo lại.`,
    );
  }
  sections.push(parts.readOnly ? SAFE_READ_ONLY_BLOCK : SAFE_WORK_BLOCK);
  return composePrompt(sections.join('\n\n'), parts.acceptance);
}
