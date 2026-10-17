/**
 * Factories for the company client tests.
 *
 * These build the smallest object of each kind that still exercises the rule
 * under test, from the wire types themselves. Nothing here fakes a server
 * response: a test that wants a snapshot composes one and feeds it through the
 * real reducer.
 */

import { randomUUID } from 'node:crypto';

import type {
  AcceptanceCriterion,
  Attempt,
  CompanyModelCatalogEntry,
  CompanyReport,
  CompanySessionSummary,
  CompanySettings,
  Contract,
  Phase,
  Question,
  Requirement,
  Task,
  UsageRecord,
  VerificationEvidence,
} from '../../core/src/company.js';
import type { CompanySnapshot } from '../../core/src/messages.js';
import {
  applyCompanyMessage,
  type CompanyViewState,
  emptyCompanyState,
} from '../src/company/companyState.js';

export function settings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    workspacePath: '/tmp/workspace',
    maxRetainedSessions: 10,
    maxLiveRunners: 4,
    maxConcurrentModelCalls: 4,
    maxWorkers: 4,
    idleParkSeconds: 120,
    roleProfiles: {
      director: {
        role: 'director',
        requestedModel: 'openai-codex/gpt-6.1-sol',
        thinking: 'medium',
        workflowFingerprint: 'fp',
        toolsPolicy: 'read-only',
      },
    },
    verificationProfiles: {},
    ...overrides,
  };
}

export function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: randomUUID(),
    promptId: randomUUID(),
    fragmentIds: [],
    text: 'ship the thing',
    kind: 'goal',
    status: 'open',
    ...overrides,
  };
}

export function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id: randomUUID(),
    requirementIds: [],
    description: 'tests pass',
    kind: 'command',
    required: true,
    ...overrides,
  };
}

export function phase(overrides: Partial<Phase> = {}): Phase {
  return {
    id: randomUUID(),
    title: 'Build',
    ordinal: 1,
    taskIds: [],
    acceptanceIds: [],
    ...overrides,
  };
}

export function task(overrides: Partial<Task> & { code?: string } = {}): Task {
  return {
    id: randomUUID(),
    code: 'PA-T0001',
    contractId: randomUUID(),
    phaseId: randomUUID(),
    title: 'Do the work',
    requirementIds: [],
    dependsOn: [],
    workstreamId: randomUUID(),
    readScopes: [],
    writeScopes: [],
    sharedResources: [],
    acceptance: [],
    executionMode: 'session',
    status: 'planned',
    attemptIds: [],
    routeReason: 'own workstream, matching profile',
    ...overrides,
  };
}

export function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 1,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'awaiting_approval',
    ...overrides,
  };
}

export function session(overrides: Partial<CompanySessionSummary> = {}): CompanySessionSummary {
  return {
    id: randomUUID(),
    code: 'PA-S0001',
    name: 'Worker one',
    role: 'worker',
    requestedModel: 'openai-codex/gpt-6-luna:xhigh',
    runEpoch: 3,
    status: 'busy',
    lastUsedAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

export function question(overrides: Partial<Question> = {}): Question {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    runEpoch: 1,
    kind: 'technical_choice',
    title: 'Pick a storage',
    questions: [
      {
        id: randomUUID(),
        question: 'Where should the state live?',
        options: [
          { label: 'JSON file', description: 'simple' },
          { label: 'SQLite' },
        ],
        recommended: 0,
      },
    ],
    status: 'pending',
    createdAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

export function evidence(overrides: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    id: randomUUID(),
    command: {
      id: randomUUID(),
      executable: 'npm',
      argv: ['test'],
      cwd: '.',
      timeoutSeconds: 600,
    },
    startedAt: '2026-10-02T10:00:00.000Z',
    endedAt: '2026-10-02T10:00:05.000Z',
    exitCode: 0,
    criterionIds: [],
    ...overrides,
  };
}

export function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: randomUUID(),
    taskId: randomUUID(),
    sessionId: randomUUID(),
    runEpoch: 1,
    startedAt: '2026-10-02T10:00:00.000Z',
    status: 'running',
    changes: [],
    evidenceIds: [],
    ...overrides,
  };
}

export function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: randomUUID(),
    nativeSessionId: 'native-1',
    nativeEntryId: 'entry-1',
    role: 'worker',
    model: 'gpt-6-luna',
    provider: 'openai-codex',
    purpose: 'worker turn',
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    timestamp: '2026-10-02T10:00:00.000Z',
    source: 'provider',
    availability: 'reported',
    provenance: 'own_turn',
    runEpoch: 1,
    ...overrides,
  };
}

export function catalogEntry(
  overrides: Partial<CompanyModelCatalogEntry> = {},
): CompanyModelCatalogEntry {
  return {
    id: 'openai-codex/gpt-6-luna:xhigh',
    provider: 'openai-codex',
    model: 'gpt-6-luna',
    thinking: ['xhigh'],
    acceptsImages: false,
    credentialsConfigured: true,
    ...overrides,
  };
}

export function report(overrides: Partial<CompanyReport> = {}): CompanyReport {
  return {
    contractId: randomUUID(),
    revision: 1,
    requirements: [],
    relatedChanges: [],
    verificationEvidenceIds: [],
    advisorNotes: [],
    usage: [],
    sessions: [],
    ...overrides,
  };
}

export function snapshot(overrides: Partial<CompanySnapshot> = {}): CompanySnapshot {
  return {
    revision: 1,
    settings: settings(),
    prompts: [],
    contracts: [],
    tasks: [],
    sessions: [],
    questions: [],
    quotas: [],
    ...overrides,
  };
}

/** A view state produced the way the app produces one: by reducing a snapshot. */
export function stateFrom(snapshotOverride: Partial<CompanySnapshot> = {}): CompanyViewState {
  return applyCompanyMessage(emptyCompanyState(), {
    type: 'companySnapshot',
    requestId: randomUUID(),
    snapshot: snapshot(snapshotOverride),
  }).state;
}