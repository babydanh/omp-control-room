import type { ProjectBranchCompareFile } from '../../../../core/src/messages.js';

export type NewerSide = 'a' | 'b' | null;

export function chooseNewerSide(
  a: { lastCommitAt: string | null },
  b: { lastCommitAt: string | null },
): NewerSide {
  if (a.lastCommitAt === null || b.lastCommitAt === null) return null;
  const aTime = Date.parse(a.lastCommitAt);
  const bTime = Date.parse(b.lastCommitAt);
  if (aTime === bTime || Number.isNaN(aTime) || Number.isNaN(bTime)) return null;
  return aTime > bTime ? 'a' : 'b';
}

export function classifyComparedFiles(files: readonly ProjectBranchCompareFile[]): {
  both: string[];
  onlyA: string[];
  onlyB: string[];
} {
  const both: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const file of files) {
    if (file.inA && file.inB) both.push(file.path);
    else if (file.inA) onlyA.push(file.path);
    else if (file.inB) onlyB.push(file.path);
  }
  return { both, onlyA, onlyB };
}

export function chooseMergeFirst(countA: number, countB: number, branchA: string, branchB: string): string {
  if (countA === countB) return branchA;
  return countA < countB ? branchA : branchB;
}

export function composeRebaseMessage(input: { file: string; line: number; checkout: string; branch: string }): string {
  return `Hãy xử lý xung đột tại ${input.file}:${input.line}, giữ lại ý của cả hai nhánh rồi kiểm tra lại.\nChạy lệnh: git -C ${input.checkout} rebase ${input.branch}`;
}
