import type { CompanyEvent } from './messages.js';

export type {
  AcceptanceCriterion,
  ArtifactPage,
  Attempt,
  CompanyArchitectureIssue,
  CompanyArchitectureReview,
  CompanyCounters,
  CompanyDiagnostics,
  CompanyEvent,
  CompanyFileContent,
  CompanyFileEntry,
  CompanyModelCatalogEntry,
  CompanyPrompt,
  CompanyPromptSummary,
  CompanyReport,
  CompanyRole,
  CompanySession,
  CompanySessionSummary,
  CompanySettings,
  CompanySnapshot,
  CompanyState,
  Contract,
  Phase,
  PromptAttachment,
  PromptFragment,
  Question,
  QuestionAnswer,
  QuestionAnswerInput,
  QuestionOption,
  QuestionPrompt,
  QuotaSnapshot,
  QuotaWindow,
  ReadScope,
  RelatedWorkspaceFile,
  Requirement,
  RequirementResult,
  RoleProfile,
  SessionLifecycleSummary,
  SubmitPromptInput,
  Task,
  UsageProvenance,
  UsageRecord,
  VerificationCommand,
  VerificationEvidence,
  VerificationProfile,
  WorkspaceChange,
  WriteScope,
} from './messages.js';

/**
 * Modelina names the oneOf members of `CompanyChange` rather than emitting a
 * `CompanyChange` declaration, so the domain derives the discriminated union
 * from the event that carries it.
 */
export type CompanyChange = CompanyEvent['changes'][number];
