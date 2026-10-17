import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  AcceptanceCriterion,
  CompanyPrompt,
  Phase,
  Requirement,
  Task,
  VerificationProfile,
} from '../../core/src/company.js';
import { createPromptSubmission } from '../src/company/companyEngine.js';
import { CompanyError } from '../src/company/companyError.js';
import { applyCompanyEvent, createInitialCompanyState } from '../src/company/companyState.js';
import type { ContractDraftProposal } from '../src/company/contractDraft.js';
import { createContractDraft } from '../src/company/contractDraft.js';

const NOW = '2026-10-02T12:00:00.000Z';

type Fixture = { state: ReturnType<typeof createInitialCompanyState>; prompt: CompanyPrompt };

function submitPrompt(
  targetContractId?: string,
  previousState = createInitialCompanyState('C:/workspace'),
): Fixture {
  const result = createPromptSubmission(previousState, {
    prompt: {
      requestId: randomUUID(),
      text: 'Render team standings.\n\nRank by points.',
      ...(targetContractId === undefined ? {} : { targetContractId }),
      delivery: targetContractId === undefined ? 'prompt' : 'follow_up',
    },
    rawTextArtifactId: 'prompt-artifact-1',
    now: NOW,
  });
  const state = applyCompanyEvent(previousState, result.events[0]!);
  const promptChange = result.events[0]!.changes.find(
    (change) => change.entity === 'prompt' && change.op === 'put',
  );
  if (!promptChange || promptChange.entity !== 'prompt' || promptChange.op !== 'put') {
    throw new Error('Prompt submission did not produce a prompt record.');
  }
  return { state, prompt: promptChange.value };
}

function proposal(prompt: CompanyPrompt): {
  value: ContractDraftProposal;
  verificationProfiles: Record<string, VerificationProfile>;
} {
  const fragments = prompt.fragments ?? [];
  const requirements: Requirement[] = fragments.map((fragment, index) => ({
    id: randomUUID(),
    promptId: prompt.id,
    fragmentIds: [fragment.id],
    text: index === 0 ? 'Render team standings.' : 'Rank by points.',
    kind: 'goal',
    status: 'planned',
  }));
  const command: AcceptanceCriterion = {
    id: randomUUID(),
    requirementIds: [requirements[0]!.id],
    description: 'The focused unit tests pass.',
    kind: 'command',
    required: true,
  };
  const review: AcceptanceCriterion = {
    id: randomUUID(),
    requirementIds: [requirements[1]!.id],
    description: 'The standings ranking is reviewed.',
    kind: 'review',
    required: false,
  };
  const taskId = randomUUID();
  const phase: Phase = {
    id: randomUUID(),
    title: 'Standings',
    ordinal: 0,
    taskIds: [taskId],
    acceptanceIds: [command.id, review.id],
  };
  const task: Omit<Task, 'code' | 'contractId' | 'status' | 'attemptIds'> = {
    id: taskId,
    phaseId: phase.id,
    title: 'Implement standings',
    requirementIds: requirements.map((entry) => entry.id),
    dependsOn: [],
    workstreamId: 'frontend',
    readScopes: [{ path: 'src', kind: 'directory', operations: ['read', 'list', 'search'] }],
    writeScopes: [{ path: 'src/standings.tsx', kind: 'file', operations: ['create', 'modify'] }],
    sharedResources: [],
    acceptance: [command.id, review.id],
    executionMode: 'session',
    routeReason: 'One independent UI slice.',
  };
  const value: ContractDraftProposal = {
    title: 'Team standings',
    summary: 'Render the requested team standings.',
    requirements,
    phases: [phase],
    tasks: [task],
    assumptions: [],
    decisions: [],
    acceptance: [command, review],
  };
  return {
    value,
    verificationProfiles: {
      [command.id]: {
        id: 'frontend-unit',
        criterionIds: [command.id],
        commands: [
          { id: 'unit', executable: 'npm', argv: ['test'], cwd: 'server', timeoutSeconds: 600 },
        ],
        prerequisites: [],
        outputScopes: [],
      },
    },
  };
}

function expectCompanyError(run: () => unknown, code: string): void {
  try {
    run();
    expect.fail(`Expected CompanyError ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).code).toBe(code);
  }
}

describe('Company Contract draft creation', () => {
  it('validates a draft before atomically assigning IDs, codes, counters, and profiles', () => {
    const { state, prompt } = submitPrompt();
    const draft = proposal(prompt);
    const result = createContractDraft(state, {
      promptId: prompt.id,
      proposal: draft.value,
      verificationProfiles: draft.verificationProfiles,
      now: NOW,
      newEvent: { id: 'draft-event-1' },
    });

    expect(result.events).toHaveLength(1);
    const next = applyCompanyEvent(state, result.events[0]!);
    const contract = Object.values(next.contracts)[0]!;
    const task = Object.values(next.tasks)[0]!;
    const criterion = contract.acceptance.find((entry) => entry.kind === 'command')!;

    expect(contract).toMatchObject({
      code: 'PA-C0001',
      revision: 1,
      promptIds: [prompt.id],
      status: 'architecture_review',
      title: 'Team standings',
    });
    expect(task).toMatchObject({
      code: 'PA-T0001',
      contractId: contract.id,
      status: 'planned',
      attemptIds: [],
    });
    expect(next.settings.verificationProfiles[criterion.id]).toEqual(
      draft.verificationProfiles[criterion.id],
    );
    expect(next.counters).toEqual({ session: 0, task: 1, contract: 1 });
    expect(result.events[0]).toMatchObject({ id: 'draft-event-1', at: NOW, sequence: 2 });
  });

  it('refuses an uncovered prompt fragment without returning a committable event', () => {
    const { state, prompt } = submitPrompt();
    const draft = proposal(prompt);
    draft.value.requirements.pop();

    expectCompanyError(
      () =>
        createContractDraft(state, {
          promptId: prompt.id,
          proposal: draft.value,
          verificationProfiles: draft.verificationProfiles,
          now: NOW,
          newEvent: { id: 'draft-event-invalid' },
        }),
      'contract_draft_invalid',
    );
    expect(state.revision).toBe(1);
    expect(Object.keys(state.contracts)).toHaveLength(0);
  });

  it('revises only an unstarted draft, preserving its identity and consuming fresh task codes', () => {
    const first = submitPrompt();
    const firstDraft = proposal(first.prompt);
    const created = createContractDraft(first.state, {
      promptId: first.prompt.id,
      proposal: firstDraft.value,
      verificationProfiles: firstDraft.verificationProfiles,
      now: NOW,
      newEvent: { id: 'draft-event-1' },
    });
    const withDraft = applyCompanyEvent(first.state, created.events[0]!);
    const contract = Object.values(withDraft.contracts)[0]!;
    const previousTask = contract.tasks[0]!;

    const followUp = submitPrompt(contract.id, withDraft);
    expect(followUp.prompt.targetContractId).toBe(contract.id);
    const revisionProposal = proposal(followUp.prompt);
    const revised = createContractDraft(followUp.state, {
      promptId: followUp.prompt.id,
      proposal: revisionProposal.value,
      verificationProfiles: revisionProposal.verificationProfiles,
      now: NOW,
      newEvent: { id: 'draft-event-2' },
    });
    const next = applyCompanyEvent(followUp.state, revised.events[0]!);
    const nextContract = next.contracts[contract.id]!;

    expect(nextContract).toMatchObject({ id: contract.id, code: contract.code, revision: 2 });
    expect(nextContract.promptIds).toEqual([first.prompt.id, followUp.prompt.id]);
    expect(next.tasks[previousTask.id]).toBeUndefined();
    expect(nextContract.tasks[0]?.code).toBe('PA-T0002');
    expect(next.counters).toEqual({ session: 0, task: 2, contract: 1 });
  });
  it('rejects a draft revision with an unknown persisted task status', () => {
    const first = submitPrompt();
    const firstDraft = proposal(first.prompt);
    const created = createContractDraft(first.state, {
      promptId: first.prompt.id,
      proposal: firstDraft.value,
      verificationProfiles: firstDraft.verificationProfiles,
      now: NOW,
      newEvent: { id: 'draft-event-1' },
    });
    const withDraft = applyCompanyEvent(first.state, created.events[0]!);
    const contract = Object.values(withDraft.contracts)[0]!;
    const followUp = submitPrompt(contract.id, withDraft);
    const taskId = contract.tasks[0]!.id;
    followUp.state.tasks[taskId] = {
      ...followUp.state.tasks[taskId]!,
      status: 'blocked' as Task['status'],
    };
    const revisionProposal = proposal(followUp.prompt);

    expectCompanyError(
      () =>
        createContractDraft(followUp.state, {
          promptId: followUp.prompt.id,
          proposal: revisionProposal.value,
          verificationProfiles: revisionProposal.verificationProfiles,
          now: NOW,
          newEvent: { id: 'draft-event-invalid-revision' },
        }),
      'contract_revision_has_work',
    );
  });
});
