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
  'Việc này chỉ đọc: không sửa file, không push thẳng lên main. Khi xong, báo lại kết quả kèm bằng chứng: các file:dòng đã xem, các lệnh đã chạy và mã thoát của từng lệnh.';

/**
 * Every item runs unattended: the user is not watching the agent, and a question stops the item
 * until someone answers. The judge reads the report, so the report has to carry the evidence.
 */
export const UNATTENDED_BLOCK =
  'Việc này do Đội giao và chạy không có người trực: không hỏi lại người dùng, không đưa lựa chọn A/B, không dùng tool hỏi (ask), không mở plan chờ duyệt. ' +
  'Thiếu thông tin thì tự tra trong code; chỗ phải quyết thì chọn hướng an toàn, làm tiếp và ghi rõ giả định trong báo cáo. ' +
  'Việc không đảo ngược được (push hay gộp vào main, deploy, xoá dữ liệu, đụng secret) thì không tự làm: ghi vào báo cáo để người dùng quyết.';

/** The default worker. Naming it adds no subagent line. */
export const DEFAULT_AGENT = 'task';

/**
 * Which engine runs the item. Its subagent line names the engine's own way to run a role: omp has
 * the task tool, Claude Code its own agents; another agent (agy, an unknown pane) just takes the role.
 */
export type PromptEngine = 'omp' | 'claude' | 'other';

/**
 * The board's agent names come from omp's catalog. Claude Code names some of the same roles its own
 * way: omp's read-only `scout` is Claude's `Explore`. A name not listed here is used as it is
 * (reviewer, security-reviewer and sonic exist on both).
 */
const CLAUDE_AGENT_FOR: Readonly<Record<string, string>> = { scout: 'Explore' };

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
 * than the default), the safe-work block, the unattended block, then "Xong khi: …" as the last line
 * when there is one.
 */
export function composeDispatchPrompt(parts: DispatchPromptParts): string {
  const sections = [parts.text.trim()];
  if (parts.agent !== undefined && parts.agent !== '' && parts.agent !== DEFAULT_AGENT) {
    sections.push(
      parts.engine === 'claude'
        ? `Làm việc này bằng subagent \`${CLAUDE_AGENT_FOR[parts.agent] ?? parts.agent}\` của Claude Code (vai trò ${parts.agent}), rồi tổng hợp kết quả và báo lại.`
        : parts.engine === 'other'
          ? `Làm việc này theo vai trò \`${parts.agent}\`, rồi tổng hợp kết quả và báo lại.`
          : `Làm việc này bằng subagent omp \`${parts.agent}\` (tool task, agent: ${parts.agent}), rồi tổng hợp kết quả và báo lại.`,
    );
  }
  sections.push(parts.readOnly ? SAFE_READ_ONLY_BLOCK : SAFE_WORK_BLOCK, UNATTENDED_BLOCK);
  return composePrompt(sections.join('\n\n'), parts.acceptance);
}
