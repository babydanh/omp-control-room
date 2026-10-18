import type { CompanyEvent, CompanyRole } from './messages.js';

export type {
  AcceptanceCriterion,
  AgentInfo,
  AgentSkillInfo,
  AgentToolInfo,
  AgentToolUsage,
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
  CompanySessionLogEntry,
  CompanySessionSummary,
  CompanySettings,
  CompanySnapshot,
  CompanyState,
  Contract,
  HerdrAgent,
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

/** The host role a Company role runs on when the host has nothing more specific. */
export const COMPANY_HOST_DEFAULT_ROLE = 'default';

/**
 * The host OMP `modelRoles` entry each Company role reads first. A role the
 * host has not set borrows {@link COMPANY_HOST_DEFAULT_ROLE}. The host's own
 * `judge` role is a one-shot classifier, not an agent that can verify work, so
 * Company's Judge deliberately runs on `default` like QA. Shared with the board,
 * which labels each role with the host role its model comes from.
 */
export const COMPANY_HOST_ROLE_BY_ROLE: Readonly<Record<CompanyRole, string>> = {
  director: 'plan',
  advisor: 'advisor',
  worker: 'task',
  qa: COMPANY_HOST_DEFAULT_ROLE,
  judge: COMPANY_HOST_DEFAULT_ROLE,
  // A chat session is a plain omp session, so it runs on omp's own default model.
  chat: COMPANY_HOST_DEFAULT_ROLE,
};
