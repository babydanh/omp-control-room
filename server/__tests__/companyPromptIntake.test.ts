import { describe, expect, it } from 'vitest';

import { createPromptSubmission } from '../src/company/companyEngine.js';
import { createInitialCompanyState } from '../src/company/companyState.js';

const now = '2026-10-02T00:00:00.000Z';

describe('company prompt intake', () => {
  it('keeps every prompt fragment and attachment linked to its stored prompt', () => {
    const text =
      'Implement this 🧑🏽‍💻.\n\n1. inspect related files\n2. add a regression test\n\nDo not alter unrelated files.';
    const attachments = [
      {
        artifactId: 'c49254d5-a11f-4e4f-9f49-71b62b770c6f',
        fileName: 'screen.png',
        mediaType: 'image/png',
        byteLength: 12,
        sha256: 'sha256',
      },
    ];
    const result = createPromptSubmission(createInitialCompanyState('C:/workspace'), {
      prompt: {
        requestId: 'request-1',
        text,
        targetContractId: 'contract-1',
        delivery: 'prompt',
        attachments,
      },
      rawTextArtifactId: 'a808ab7e-1ad4-45b6-994b-e9c209289934',
      now,
    });
    const change = result.events[0]?.changes.find(
      (entry) => entry.entity === 'prompt' && entry.op === 'put',
    );
    expect(change?.entity).toBe('prompt');
    if (!change || change.entity !== 'prompt' || change.op !== 'put') return;

    const prompt = change.value;
    expect(prompt.targetContractId).toBe('contract-1');
    expect(prompt.attachments).toEqual(attachments);
    expect(prompt.fragments.map((fragment) => text.slice(fragment.start, fragment.end))).toEqual([
      'Implement this 🧑🏽‍💻.\n\n',
      '1. inspect related files\n',
      '2. add a regression test\n\n',
      'Do not alter unrelated files.',
    ]);
    expect(prompt.fragments.map((fragment) => fragment.ordinal)).toEqual([0, 1, 2, 3]);
  });
});
