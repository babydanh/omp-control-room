/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | SettingsLoaded
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | WorkspaceFolders
  | AgentDiagnostics
  | CompanySnapshotMessage
  | CompanyStateChangedMessage
  | CompanyCommandResultMessage
  | CompanyTextDeltaMessage
  | CompanySessionLogMessage
  | HerdrAgentsMessage
  | HerdrScreenMessage
  | CompanyModelCatalogMessage
  | CompanyArtifactPageMessage
  | CompanyFileListMessage
  | CompanyFileReadMessage
  | CompanyAttachmentUploadedMessage
  | TerminalAttachedMessage
  | TerminalSnapshotMessage
  | TerminalDataMessage
  | TerminalClosedMessage;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | RequestDiagnostics
  | CompanySnapshotRequestMessage
  | CompanyPromptSubmitMessage
  | CompanyContractDecisionMessage
  | CompanyQuestionAnswerMessage
  | CompanySessionControlMessage
  | CompanySettingsUpdateMessage
  | CompanyModelCatalogRequestMessage
  | CompanyArtifactRequestMessage
  | CompanyFileListRequestMessage
  | CompanyFileReadRequestMessage
  | CompanyAttachmentUploadMessage
  | CompanySessionLogRequestMessage
  | HerdrReadMessage
  | HerdrPromptMessage
  | HerdrKeysMessage
  | HerdrFocusMessage
  | TerminalAttachMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalDetachMessage;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface WorkspaceFolders {
  type: 'workspaceFolders';
  folders: WorkspaceFolder[];
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface CompanySnapshotMessage {
  type: 'companySnapshot';
  requestId: string;
  snapshot: CompanySnapshot;
}

export interface CompanySnapshot {
  revision: number;
  settings: CompanySettings;
  prompts: CompanyPromptSummary[];
  contracts: Contract[];
  tasks: Task[];
  sessions: CompanySessionSummary[];
  questions: Question[];
  quotas: QuotaSnapshot[];
  diagnostics?: CompanyDiagnostics;
  attempts?: Attempt[];
  evidence?: VerificationEvidence[];
  reports?: CompanyReport[];
  usage?: UsageRecord[];
}

export interface CompanySettings {
  workspacePath: string;
  maxRetainedSessions: 10;
  maxLiveRunners: 4;
  maxConcurrentModelCalls: 4;
  maxWorkers: 4;
  idleParkSeconds: 120;
  roleProfiles: Record<string, RoleProfile>;
  verificationProfiles: Record<string, VerificationProfile>;
}

export interface RoleProfile {
  role: CompanyRole;
  requestedModel: string;
  thinking: string;
  workflowFingerprint: string;
  toolsPolicy: AnonymousSchema_205;
}

export type CompanyRole = 'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type AnonymousSchema_205 = 'read-only' | 'scoped-write' | 'verification-only';

export interface VerificationProfile {
  id: string;
  criterionIds: string[];
  commands: VerificationCommand[];
  prerequisites: string[];
  outputScopes: string[];
}

export interface VerificationCommand {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface CompanyPromptSummary {
  id: string;
  preview: string;
  createdAt: string;
  attachments: PromptAttachment[];
  targetSessionId?: string;
}

export interface PromptAttachment {
  artifactId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface Contract {
  id: string;
  code: string;
  revision: number;
  title?: string;
  summary?: string;
  promptIds: string[];
  requirements: Requirement[];
  phases: Phase[];
  tasks: Task[];
  assumptions: string[];
  decisions: string[];
  risks?: string[];
  acceptance: AcceptanceCriterion[];
  architectureReviews?: CompanyArchitectureReview[];
  relatedFiles?: RelatedWorkspaceFile[];
  status: AnonymousSchema_319;
}

export interface Requirement {
  id: string;
  promptId: string;
  fragmentIds: string[];
  text: string;
  kind: AnonymousSchema_246;
  status: AnonymousSchema_247;
}

export type AnonymousSchema_246 = 'goal' | 'constraint' | 'context';

export type AnonymousSchema_247 = 'open' | 'clarification' | 'planned' | 'satisfied' | 'blocked';

export interface Phase {
  id: string;
  title: string;
  ordinal: number;
  taskIds: string[];
  acceptanceIds: string[];
}

export interface Task {
  id: string;
  code: string;
  contractId: string;
  phaseId: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  workstreamId: string;
  readScopes: ReadScope[];
  writeScopes: WriteScope[];
  sharedResources: string[];
  acceptance: string[];
  executionMode: AnonymousSchema_281;
  sessionId?: string;
  status: AnonymousSchema_283;
  attemptIds: string[];
  routeReason: string;
  relatedFiles?: RelatedWorkspaceFile[];
}

export interface ReadScope {
  path: string;
  kind: AnonymousSchema_269;
  operations: AnonymousSchema_271[];
}

export type AnonymousSchema_269 = 'file' | 'directory';

export type AnonymousSchema_271 = 'read' | 'list' | 'search';

export interface WriteScope {
  path: string;
  kind: AnonymousSchema_274;
  operations: AnonymousSchema_276[];
}

export type AnonymousSchema_274 = 'file' | 'directory';

export type AnonymousSchema_276 = 'create' | 'modify';

export type AnonymousSchema_281 = 'inline' | 'subagent' | 'session';

export type AnonymousSchema_283 =
  | 'planned'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'paused'
  | 'verifying'
  | 'changes_requested'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface RelatedWorkspaceFile {
  path: string;
  relation: AnonymousSchema_289;
  reason?: string;
  artifactId?: string;
}

export type AnonymousSchema_289 = 'source' | 'changed' | 'test' | 'config' | 'evidence';

export interface AcceptanceCriterion {
  id: string;
  requirementIds: string[];
  description: string;
  kind: AnonymousSchema_303;
  required: boolean;
}

export type AnonymousSchema_303 = 'command' | 'surface' | 'review';

export interface CompanyArchitectureReview {
  revision: number;
  verdict: AnonymousSchema_307;
  issues: CompanyArchitectureIssue[];
  advisorNotes: string[];
  reviewedAt: string;
}

export type AnonymousSchema_307 = 'approve' | 'changes_requested';

export interface CompanyArchitectureIssue {
  severity: AnonymousSchema_309;
  requirementIds: string[];
  evidence: string[];
  fix: string;
}

export type AnonymousSchema_309 = 'P0' | 'P1' | 'P2' | 'P3';

export type AnonymousSchema_319 =
  | 'draft'
  | 'clarifying'
  | 'architecture_review'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export interface CompanySessionSummary {
  id: string;
  code: string;
  name: string;
  role: CompanyRole;
  requestedModel: string;
  effectiveModel?: string;
  agentId?: number;
  runEpoch: number;
  status: string;
  activeTaskId?: string;
  lastUsedAt: string;
  contextSnapshot?: Record<string, any>;
}

export interface Question {
  id: string;
  sessionId: string;
  taskId?: string;
  runEpoch: number;
  nativeToolCallId?: string;
  kind: AnonymousSchema_339;
  title: string;
  questions: QuestionPrompt[];
  actionDigest?: string;
  status: AnonymousSchema_350;
  answer?: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export type AnonymousSchema_339 = 'clarification' | 'technical_choice' | 'approval';

export interface QuestionPrompt {
  id: string;
  question: string;
  options: QuestionOption[];
  recommended?: number;
  multi?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export type AnonymousSchema_350 = 'pending' | 'answered' | 'rejected' | 'cancelled' | 'expired';

export interface QuotaSnapshot {
  provider: string;
  accountLabel?: string;
  windows: QuotaWindow[];
  fetchedAt: string;
  status: AnonymousSchema_364;
}

export interface QuotaWindow {
  label: string;
  used?: number;
  remaining?: number;
  resetAt?: string;
  reportedUnit: string;
}

export type AnonymousSchema_364 =
  'available' | 'unsupported' | 'unauthenticated' | 'error' | 'stale';

export interface CompanyDiagnostics {
  liveRunners: number;
  modelLeases: number;
  nativeJobs: number;
  queuedTasks: number;
  pendingQuestions: number;
  retainedSessions: number;
  archivedSessions: number;
  terminalBufferedBytes: number;
  ownedHandleCount: number;
  ownedRssBytes?: number;
  measuredAt: string;
}

export interface Attempt {
  id: string;
  taskId: string;
  sessionId: string;
  runEpoch: number;
  startedAt: string;
  endedAt?: string;
  status: AnonymousSchema_383;
  changes: WorkspaceChange[];
  evidenceIds: string[];
  qaVerdict?: Record<string, any>;
  judgeVerdict?: Record<string, any>;
  error?: string;
}

export type AnonymousSchema_383 = 'running' | 'passed' | 'failed' | 'interrupted' | 'blocked';

export interface WorkspaceChange {
  path: string;
  kind: AnonymousSchema_386;
  summary: string;
  diffArtifactId?: string;
}

export type AnonymousSchema_386 = 'create' | 'modify' | 'delete';

export interface VerificationEvidence {
  id: string;
  command: VerificationCommand;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  signal?: string;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  prerequisites?: string[];
  criterionIds: string[];
}

export interface CompanyReport {
  contractId: string;
  revision: number;
  requirements: RequirementResult[];
  relatedChanges: WorkspaceChange[];
  verificationEvidenceIds: string[];
  advisorNotes: string[];
  usage: UsageRecord[];
  sessions: SessionLifecycleSummary[];
}

export interface RequirementResult {
  requirementId: string;
  taskIds: string[];
  attemptIds: string[];
  evidenceIds: string[];
  result: string;
}

export interface UsageRecord {
  sessionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  role: CompanyRole;
  model: string;
  provider: string;
  purpose: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  timestamp: string;
  source: AnonymousSchema_436;
  availability: string;
  provenance: UsageProvenance;
  toolCallId?: string;
  runEpoch: number;
  taskId?: string;
  contractId?: string;
  totalTokens?: number;
}

export type AnonymousSchema_436 = 'provider' | 'native_session';

export type UsageProvenance = 'own_turn' | 'native_child' | 'child_aggregate';

export interface SessionLifecycleSummary {
  sessionId: string;
  role: CompanyRole;
  requestedModel: string;
  effectiveModel?: string;
  runEpoch: number;
  status: string;
}

export interface CompanyStateChangedMessage {
  type: 'companyStateChanged';
  revision: number;
  changes: (
    | CompanyPromptPutChange
    | CompanyContractPutChange
    | CompanyTaskPutChange
    | CompanySessionPutChange
    | CompanyQuestionPutChange
    | CompanyAttemptPutChange
    | CompanyReportPutChange
    | CompanyEvidencePutChange
    | CompanySettingsPutChange
    | CompanyUsagePutChange
    | CompanyQuotaPutChange
    | CompanyCountersPutChange
    | CompanyRemoveChange
  )[];
}

export interface CompanyPromptPutChange {
  entity: 'prompt';
  op: 'put';
  id: string;
  value: CompanyPrompt;
}

export interface CompanyPrompt {
  id: string;
  rawTextArtifactId: string;
  preview: string;
  createdAt: string;
  fragments: PromptFragment[];
  attachments?: PromptAttachment[];
  targetContractId?: string;
  targetSessionId?: string;
  routingReason?: string;
}

export interface PromptFragment {
  id: string;
  start: number;
  end: number;
  ordinal: number;
}

export interface CompanyContractPutChange {
  entity: 'contract';
  op: 'put';
  id: string;
  value: Contract;
}

export interface CompanyTaskPutChange {
  entity: 'task';
  op: 'put';
  id: string;
  value: Task;
}

export interface CompanySessionPutChange {
  entity: 'session';
  op: 'put';
  id: string;
  value: CompanySession;
}

export interface CompanySession {
  id: string;
  code: string;
  name: string;
  role: CompanyRole;
  workstreamId: string;
  workspaceKey: string;
  requestedModel: string;
  effectiveModel?: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
  agentId?: number;
  runEpoch: number;
  status: AnonymousSchema_489;
  activeTaskId?: string;
  lastUsedAt: string;
  contextSnapshot?: Record<string, any>;
  handoffArtifactId?: string;
}

export type AnonymousSchema_489 =
  | 'parked'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'waiting_input'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'archived';

export interface CompanyQuestionPutChange {
  entity: 'question';
  op: 'put';
  id: string;
  value: Question;
}

export interface CompanyAttemptPutChange {
  entity: 'attempt';
  op: 'put';
  id: string;
  value: Attempt;
}

export interface CompanyReportPutChange {
  entity: 'report';
  op: 'put';
  id: string;
  value: CompanyReport;
}

export interface CompanyEvidencePutChange {
  entity: 'evidence';
  op: 'put';
  id: string;
  value: VerificationEvidence;
}

export interface CompanySettingsPutChange {
  entity: 'settings';
  op: 'put';
  id: 'settings';
  value: CompanySettings;
}

export interface CompanyUsagePutChange {
  entity: 'usage';
  op: 'put';
  id: string;
  value: UsageRecord;
}

export interface CompanyQuotaPutChange {
  entity: 'quota';
  op: 'put';
  id: string;
  value: QuotaSnapshot;
}

export interface CompanyCountersPutChange {
  entity: 'counters';
  op: 'put';
  id: 'counters';
  value: CompanyCounters;
}

export interface CompanyCounters {
  session: number;
  task: number;
  contract: number;
}

export interface CompanyRemoveChange {
  entity: AnonymousSchema_521;
  op: 'remove';
  id: string;
}

export type AnonymousSchema_521 =
  | 'prompt'
  | 'contract'
  | 'task'
  | 'session'
  | 'question'
  | 'attempt'
  | 'report'
  | 'evidence'
  | 'usage'
  | 'quota';

export interface CompanyCommandResultMessage {
  type: 'companyCommandResult';
  requestId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
  revision?: number;
}

export interface CompanyTextDeltaMessage {
  type: 'companyTextDelta';
  sessionId: string;
  taskId?: string;
  runEpoch: number;
  seq: number;
  text: string;
}

export interface CompanySessionLogMessage {
  type: 'companySessionLog';
  requestId?: string;
  sessionId: string;
  replay: boolean;
  entries: CompanySessionLogEntry[];
}

export interface CompanySessionLogEntry {
  seq: number;
  at: string;
  kind: AnonymousSchema_543;
  runEpoch: number;
  taskId?: string;
  text: string;
  toolName?: string;
  exitCode?: number;
  ok?: boolean;
}

export type AnonymousSchema_543 =
  'text' | 'tool' | 'command' | 'verdict' | 'question' | 'state' | 'error';

export interface HerdrAgentsMessage {
  type: 'herdrAgents';
  available: boolean;
  reason?: string;
  agents: HerdrAgent[];
}

export interface HerdrAgent {
  paneId: string;
  name?: string;
  kind: string;
  status: AnonymousSchema_557;
  cwd?: string;
  title?: string;
  workspaceId: string;
  workspaceLabel?: string;
  repo?: string;
  branch?: string;
  worktreeRoot?: string;
  focused?: boolean;
}

export type AnonymousSchema_557 = 'working' | 'blocked' | 'idle' | 'done' | 'unknown';

export interface HerdrScreenMessage {
  type: 'herdrScreen';
  requestId?: string;
  paneId: string;
  text: string;
  at: string;
}

export interface CompanyModelCatalogMessage {
  type: 'companyModelCatalog';
  requestId: string;
  entries: CompanyModelCatalogEntry[];
}

export interface CompanyModelCatalogEntry {
  id: string;
  provider: string;
  model: string;
  thinking: string[];
  acceptsImages: boolean;
  credentialsConfigured: boolean;
}

export interface CompanyArtifactPageMessage {
  type: 'companyArtifactPage';
  requestId: string;
  page: ArtifactPage;
}

export interface ArtifactPage {
  id: string;
  offset: number;
  totalBytes: number;
  dataBase64: string;
  contentType: string;
  eof: boolean;
}

export interface CompanyFileListMessage {
  type: 'companyFileList';
  requestId: string;
  path: string;
  entries: CompanyFileEntry[];
}

export interface CompanyFileEntry {
  name: string;
  path: string;
  kind: AnonymousSchema_595;
  sizeBytes?: number;
  modifiedAt?: string;
}

export type AnonymousSchema_595 = 'file' | 'directory';

export interface CompanyFileReadMessage {
  type: 'companyFileRead';
  requestId: string;
  content: CompanyFileContent;
}

export interface CompanyFileContent {
  path: string;
  totalBytes: number;
  offset: number;
  encoding: AnonymousSchema_603;
  text?: string;
  dataBase64?: string;
  mediaType?: string;
  truncated: boolean;
}

export type AnonymousSchema_603 = 'utf8' | 'base64';

export interface CompanyAttachmentUploadedMessage {
  type: 'companyAttachmentUploaded';
  requestId: string;
  attachment: PromptAttachment;
}

export interface TerminalAttachedMessage {
  type: 'terminalAttached';
  requestId: string;
  sessionId: string;
  runEpoch: number;
  leaseId: string;
  cols: number;
  rows: number;
}

export interface TerminalSnapshotMessage {
  type: 'terminalSnapshot';
  sessionId: string;
  runEpoch: number;
  seq: number;
  data: string;
}

export interface TerminalDataMessage {
  type: 'terminalData';
  sessionId: string;
  runEpoch: number;
  seq: number;
  data: string;
}

export interface TerminalClosedMessage {
  type: 'terminalClosed';
  sessionId: string;
  runEpoch: number;
  seq: number;
  reason: string;
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  folderPath?: string;
  bypassPermissions?: boolean;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface CompanySnapshotRequestMessage {
  type: 'companySnapshotRequest';
  requestId: string;
  includeDiagnostics?: boolean;
}

export interface CompanyPromptSubmitMessage {
  type: 'companyPromptSubmit';
  prompt: SubmitPromptInput;
}

export interface SubmitPromptInput {
  requestId: string;
  text: string;
  targetContractId?: string;
  targetSessionId?: string;
  delivery: AnonymousSchema_685;
  attachments?: PromptAttachment[];
}

export type AnonymousSchema_685 = 'prompt' | 'steer' | 'follow_up';

export interface CompanyContractDecisionMessage {
  type: 'companyContractDecision';
  requestId: string;
  contractId: string;
  revision: number;
  decision: AnonymousSchema_691;
  note?: string;
}

export type AnonymousSchema_691 = 'approve' | 'reject';

export interface CompanyQuestionAnswerMessage {
  type: 'companyQuestionAnswer';
  answer: QuestionAnswerInput;
}

export interface QuestionAnswerInput {
  requestId: string;
  questionId: string;
  runEpoch: number;
  actionDigest?: string;
  answers: Record<string, QuestionAnswer>;
  decision?: AnonymousSchema_703;
}

export interface QuestionAnswer {
  selectedIndices: number[];
  text?: string;
  isOther: boolean;
}

export type AnonymousSchema_703 = 'approve_once' | 'reject';

export interface CompanySessionControlMessage {
  type: 'companySessionControl';
  requestId: string;
  sessionId: string;
  runEpoch: number;
  action: AnonymousSchema_708;
}

export type AnonymousSchema_708 = 'pause' | 'resume' | 'kill' | 'restart' | 'archive';

export interface CompanySettingsUpdateMessage {
  type: 'companySettingsUpdate';
  requestId: string;
  roleProfiles: Record<string, RoleProfile>;
}

export interface CompanyModelCatalogRequestMessage {
  type: 'companyModelCatalogRequest';
  requestId: string;
}

export interface CompanyArtifactRequestMessage {
  type: 'companyArtifactRequest';
  requestId: string;
  artifactId: string;
  offset: number;
  limit?: number;
}

export interface CompanyFileListRequestMessage {
  type: 'companyFileListRequest';
  requestId: string;
  path: string;
}

export interface CompanyFileReadRequestMessage {
  type: 'companyFileReadRequest';
  requestId: string;
  path: string;
  offset: number;
  limit?: number;
}

export interface CompanyAttachmentUploadMessage {
  type: 'companyAttachmentUpload';
  requestId: string;
  fileName: string;
  mediaType: string;
  dataBase64: string;
}

export interface CompanySessionLogRequestMessage {
  type: 'companySessionLogRequest';
  requestId: string;
  sessionId: string;
  limit?: number;
}

export interface HerdrReadMessage {
  type: 'herdrRead';
  requestId: string;
  paneId: string;
  lines?: number;
}

export interface HerdrPromptMessage {
  type: 'herdrPrompt';
  requestId: string;
  paneId: string;
  text: string;
}

export interface HerdrKeysMessage {
  type: 'herdrKeys';
  requestId: string;
  paneId: string;
  keys: HerdrKey[];
}

export type HerdrKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'esc'
  | 'tab'
  | 'ctrl+c'
  | '1'
  | '2'
  | '3'
  | 'y'
  | 'n';

export interface HerdrFocusMessage {
  type: 'herdrFocus';
  requestId: string;
  paneId: string;
}

export interface TerminalAttachMessage {
  type: 'terminalAttach';
  requestId: string;
  sessionId: string;
  runEpoch: number;
  cols?: number;
  rows?: number;
}

export interface TerminalInputMessage {
  type: 'terminalInput';
  sessionId: string;
  leaseId: string;
  runEpoch: number;
  data: string;
}

export interface TerminalResizeMessage {
  type: 'terminalResize';
  sessionId: string;
  runEpoch: number;
  leaseId: string;
  cols: number;
  rows: number;
}

export interface TerminalDetachMessage {
  type: 'terminalDetach';
  sessionId: string;
  runEpoch: number;
  leaseId: string;
}

export interface CompanyState {
  schemaVersion: 1;
  revision: number;
  counters: CompanyStateCounters;
  settings: CompanyStateSettings;
  prompts: Record<string, CompanyStatePromptsAdditionalProperty>;
  contracts: Record<string, CompanyStateContractsAdditionalProperty>;
  tasks: Record<string, CompanyStateTasksAdditionalProperty>;
  sessions: Record<string, CompanyStateSessionsAdditionalProperty>;
  questions: Record<string, CompanyStateQuestionsAdditionalProperty>;
  attempts: Record<string, CompanyStateAttemptsAdditionalProperty>;
  reports: Record<string, CompanyStateReportsAdditionalProperty>;
  evidence: Record<string, CompanyStateEvidenceAdditionalProperty>;
  usageIndex: Record<string, CompanyStateUsageIndexAdditionalPropertyItem[]>;
  quotas: Record<string, CompanyStateQuotasAdditionalProperty>;
}

export interface CompanyStateCounters {
  session: number;
  task: number;
  contract: number;
}

export interface CompanyStateSettings {
  workspacePath: string;
  maxRetainedSessions: 10;
  maxLiveRunners: 4;
  maxConcurrentModelCalls: 4;
  maxWorkers: 4;
  idleParkSeconds: 120;
  roleProfiles: Record<string, CompanyStateSettingsRoleProfilesAdditionalProperty>;
  verificationProfiles: Record<string, CompanyStateSettingsVerificationProfilesAdditionalProperty>;
}

export interface CompanyStateSettingsRoleProfilesAdditionalProperty {
  role: CompanyStateSettingsRoleProfilesAdditionalPropertyRole;
  requestedModel: string;
  thinking: string;
  workflowFingerprint: string;
  toolsPolicy: CompanyStateSettingsRoleProfilesAdditionalPropertyToolsPolicy;
}

export type CompanyStateSettingsRoleProfilesAdditionalPropertyRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyStateSettingsRoleProfilesAdditionalPropertyToolsPolicy =
  'read-only' | 'scoped-write' | 'verification-only';

export interface CompanyStateSettingsVerificationProfilesAdditionalProperty {
  id: string;
  criterionIds: string[];
  commands: CompanyStateSettingsVerificationProfilesAdditionalPropertyCommandsItem[];
  prerequisites: string[];
  outputScopes: string[];
}

export interface CompanyStateSettingsVerificationProfilesAdditionalPropertyCommandsItem {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface CompanyStatePromptsAdditionalProperty {
  id: string;
  rawTextArtifactId: string;
  preview: string;
  createdAt: string;
  fragments: CompanyStatePromptsAdditionalPropertyFragmentsItem[];
  attachments?: CompanyStatePromptsAdditionalPropertyAttachmentsItem[];
  targetContractId?: string;
  targetSessionId?: string;
  routingReason?: string;
}

export interface CompanyStatePromptsAdditionalPropertyFragmentsItem {
  id: string;
  start: number;
  end: number;
  ordinal: number;
}

export interface CompanyStatePromptsAdditionalPropertyAttachmentsItem {
  artifactId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface CompanyStateContractsAdditionalProperty {
  id: string;
  code: string;
  revision: number;
  title?: string;
  summary?: string;
  promptIds: string[];
  requirements: CompanyStateContractsAdditionalPropertyRequirementsItem[];
  phases: CompanyStateContractsAdditionalPropertyPhasesItem[];
  tasks: CompanyStateContractsAdditionalPropertyTasksItem[];
  assumptions: string[];
  decisions: string[];
  risks?: string[];
  acceptance: CompanyStateContractsAdditionalPropertyAcceptanceItem[];
  architectureReviews?: CompanyStateContractsAdditionalPropertyArchitectureReviewsItem[];
  relatedFiles?: CompanyStateContractsAdditionalPropertyRelatedFilesItem[];
  status: CompanyStateContractsAdditionalPropertyStatus;
}

export interface CompanyStateContractsAdditionalPropertyRequirementsItem {
  id: string;
  promptId: string;
  fragmentIds: string[];
  text: string;
  kind: CompanyStateContractsAdditionalPropertyRequirementsItemKind;
  status: CompanyStateContractsAdditionalPropertyRequirementsItemStatus;
}

export type CompanyStateContractsAdditionalPropertyRequirementsItemKind =
  'goal' | 'constraint' | 'context';

export type CompanyStateContractsAdditionalPropertyRequirementsItemStatus =
  'open' | 'clarification' | 'planned' | 'satisfied' | 'blocked';

export interface CompanyStateContractsAdditionalPropertyPhasesItem {
  id: string;
  title: string;
  ordinal: number;
  taskIds: string[];
  acceptanceIds: string[];
}

export interface CompanyStateContractsAdditionalPropertyTasksItem {
  id: string;
  code: string;
  contractId: string;
  phaseId: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  workstreamId: string;
  readScopes: CompanyStateContractsAdditionalPropertyTasksItemReadScopesItem[];
  writeScopes: CompanyStateContractsAdditionalPropertyTasksItemWriteScopesItem[];
  sharedResources: string[];
  acceptance: string[];
  executionMode: CompanyStateContractsAdditionalPropertyTasksItemExecutionMode;
  sessionId?: string;
  status: CompanyStateContractsAdditionalPropertyTasksItemStatus;
  attemptIds: string[];
  routeReason: string;
  relatedFiles?: CompanyStateContractsAdditionalPropertyTasksItemRelatedFilesItem[];
}

export interface CompanyStateContractsAdditionalPropertyTasksItemReadScopesItem {
  path: string;
  kind: CompanyStateContractsAdditionalPropertyTasksItemReadScopesItemKind;
  operations: CompanyStateContractsAdditionalPropertyTasksItemReadScopesItemOperationsItem[];
}

export type CompanyStateContractsAdditionalPropertyTasksItemReadScopesItemKind =
  'file' | 'directory';

export type CompanyStateContractsAdditionalPropertyTasksItemReadScopesItemOperationsItem =
  'read' | 'list' | 'search';

export interface CompanyStateContractsAdditionalPropertyTasksItemWriteScopesItem {
  path: string;
  kind: CompanyStateContractsAdditionalPropertyTasksItemWriteScopesItemKind;
  operations: CompanyStateContractsAdditionalPropertyTasksItemWriteScopesItemOperationsItem[];
}

export type CompanyStateContractsAdditionalPropertyTasksItemWriteScopesItemKind =
  'file' | 'directory';

export type CompanyStateContractsAdditionalPropertyTasksItemWriteScopesItemOperationsItem =
  'create' | 'modify';

export type CompanyStateContractsAdditionalPropertyTasksItemExecutionMode =
  'inline' | 'subagent' | 'session';

export type CompanyStateContractsAdditionalPropertyTasksItemStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'paused'
  | 'verifying'
  | 'changes_requested'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CompanyStateContractsAdditionalPropertyTasksItemRelatedFilesItem {
  path: string;
  relation: CompanyStateContractsAdditionalPropertyTasksItemRelatedFilesItemRelation;
  reason?: string;
  artifactId?: string;
}

export type CompanyStateContractsAdditionalPropertyTasksItemRelatedFilesItemRelation =
  'source' | 'changed' | 'test' | 'config' | 'evidence';

export interface CompanyStateContractsAdditionalPropertyAcceptanceItem {
  id: string;
  requirementIds: string[];
  description: string;
  kind: CompanyStateContractsAdditionalPropertyAcceptanceItemKind;
  required: boolean;
}

export type CompanyStateContractsAdditionalPropertyAcceptanceItemKind =
  'command' | 'surface' | 'review';

export interface CompanyStateContractsAdditionalPropertyArchitectureReviewsItem {
  revision: number;
  verdict: CompanyStateContractsAdditionalPropertyArchitectureReviewsItemVerdict;
  issues: CompanyStateContractsAdditionalPropertyArchitectureReviewsItemIssuesItem[];
  advisorNotes: string[];
  reviewedAt: string;
}

export type CompanyStateContractsAdditionalPropertyArchitectureReviewsItemVerdict =
  'approve' | 'changes_requested';

export interface CompanyStateContractsAdditionalPropertyArchitectureReviewsItemIssuesItem {
  severity: CompanyStateContractsAdditionalPropertyArchitectureReviewsItemIssuesItemSeverity;
  requirementIds: string[];
  evidence: string[];
  fix: string;
}

export type CompanyStateContractsAdditionalPropertyArchitectureReviewsItemIssuesItemSeverity =
  'P0' | 'P1' | 'P2' | 'P3';

export interface CompanyStateContractsAdditionalPropertyRelatedFilesItem {
  path: string;
  relation: CompanyStateContractsAdditionalPropertyRelatedFilesItemRelation;
  reason?: string;
  artifactId?: string;
}

export type CompanyStateContractsAdditionalPropertyRelatedFilesItemRelation =
  'source' | 'changed' | 'test' | 'config' | 'evidence';

export type CompanyStateContractsAdditionalPropertyStatus =
  | 'draft'
  | 'clarifying'
  | 'architecture_review'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export interface CompanyStateTasksAdditionalProperty {
  id: string;
  code: string;
  contractId: string;
  phaseId: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  workstreamId: string;
  readScopes: CompanyStateTasksAdditionalPropertyReadScopesItem[];
  writeScopes: CompanyStateTasksAdditionalPropertyWriteScopesItem[];
  sharedResources: string[];
  acceptance: string[];
  executionMode: CompanyStateTasksAdditionalPropertyExecutionMode;
  sessionId?: string;
  status: CompanyStateTasksAdditionalPropertyStatus;
  attemptIds: string[];
  routeReason: string;
  relatedFiles?: CompanyStateTasksAdditionalPropertyRelatedFilesItem[];
}

export interface CompanyStateTasksAdditionalPropertyReadScopesItem {
  path: string;
  kind: CompanyStateTasksAdditionalPropertyReadScopesItemKind;
  operations: CompanyStateTasksAdditionalPropertyReadScopesItemOperationsItem[];
}

export type CompanyStateTasksAdditionalPropertyReadScopesItemKind = 'file' | 'directory';

export type CompanyStateTasksAdditionalPropertyReadScopesItemOperationsItem =
  'read' | 'list' | 'search';

export interface CompanyStateTasksAdditionalPropertyWriteScopesItem {
  path: string;
  kind: CompanyStateTasksAdditionalPropertyWriteScopesItemKind;
  operations: CompanyStateTasksAdditionalPropertyWriteScopesItemOperationsItem[];
}

export type CompanyStateTasksAdditionalPropertyWriteScopesItemKind = 'file' | 'directory';

export type CompanyStateTasksAdditionalPropertyWriteScopesItemOperationsItem = 'create' | 'modify';

export type CompanyStateTasksAdditionalPropertyExecutionMode = 'inline' | 'subagent' | 'session';

export type CompanyStateTasksAdditionalPropertyStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'paused'
  | 'verifying'
  | 'changes_requested'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CompanyStateTasksAdditionalPropertyRelatedFilesItem {
  path: string;
  relation: CompanyStateTasksAdditionalPropertyRelatedFilesItemRelation;
  reason?: string;
  artifactId?: string;
}

export type CompanyStateTasksAdditionalPropertyRelatedFilesItemRelation =
  'source' | 'changed' | 'test' | 'config' | 'evidence';

export interface CompanyStateSessionsAdditionalProperty {
  id: string;
  code: string;
  name: string;
  role: CompanyStateSessionsAdditionalPropertyRole;
  workstreamId: string;
  workspaceKey: string;
  requestedModel: string;
  effectiveModel?: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
  agentId?: number;
  runEpoch: number;
  status: CompanyStateSessionsAdditionalPropertyStatus;
  activeTaskId?: string;
  lastUsedAt: string;
  contextSnapshot?: Record<string, any>;
  handoffArtifactId?: string;
}

export type CompanyStateSessionsAdditionalPropertyRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyStateSessionsAdditionalPropertyStatus =
  | 'parked'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'waiting_input'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'archived';

export interface CompanyStateQuestionsAdditionalProperty {
  id: string;
  sessionId: string;
  taskId?: string;
  runEpoch: number;
  nativeToolCallId?: string;
  kind: CompanyStateQuestionsAdditionalPropertyKind;
  title: string;
  questions: CompanyStateQuestionsAdditionalPropertyQuestionsItem[];
  actionDigest?: string;
  status: CompanyStateQuestionsAdditionalPropertyStatus;
  answer?: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export type CompanyStateQuestionsAdditionalPropertyKind =
  'clarification' | 'technical_choice' | 'approval';

export interface CompanyStateQuestionsAdditionalPropertyQuestionsItem {
  id: string;
  question: string;
  options: CompanyStateQuestionsAdditionalPropertyQuestionsItemOptionsItem[];
  recommended?: number;
  multi?: boolean;
}

export interface CompanyStateQuestionsAdditionalPropertyQuestionsItemOptionsItem {
  label: string;
  description?: string;
}

export type CompanyStateQuestionsAdditionalPropertyStatus =
  'pending' | 'answered' | 'rejected' | 'cancelled' | 'expired';

export interface CompanyStateAttemptsAdditionalProperty {
  id: string;
  taskId: string;
  sessionId: string;
  runEpoch: number;
  startedAt: string;
  endedAt?: string;
  status: CompanyStateAttemptsAdditionalPropertyStatus;
  changes: CompanyStateAttemptsAdditionalPropertyChangesItem[];
  evidenceIds: string[];
  qaVerdict?: Record<string, any>;
  judgeVerdict?: Record<string, any>;
  error?: string;
}

export type CompanyStateAttemptsAdditionalPropertyStatus =
  'running' | 'passed' | 'failed' | 'interrupted' | 'blocked';

export interface CompanyStateAttemptsAdditionalPropertyChangesItem {
  path: string;
  kind: CompanyStateAttemptsAdditionalPropertyChangesItemKind;
  summary: string;
  diffArtifactId?: string;
}

export type CompanyStateAttemptsAdditionalPropertyChangesItemKind = 'create' | 'modify' | 'delete';

export interface CompanyStateReportsAdditionalProperty {
  contractId: string;
  revision: number;
  requirements: CompanyStateReportsAdditionalPropertyRequirementsItem[];
  relatedChanges: CompanyStateReportsAdditionalPropertyRelatedChangesItem[];
  verificationEvidenceIds: string[];
  advisorNotes: string[];
  usage: CompanyStateReportsAdditionalPropertyUsageItem[];
  sessions: CompanyStateReportsAdditionalPropertySessionsItem[];
}

export interface CompanyStateReportsAdditionalPropertyRequirementsItem {
  requirementId: string;
  taskIds: string[];
  attemptIds: string[];
  evidenceIds: string[];
  result: string;
}

export interface CompanyStateReportsAdditionalPropertyRelatedChangesItem {
  path: string;
  kind: CompanyStateReportsAdditionalPropertyRelatedChangesItemKind;
  summary: string;
  diffArtifactId?: string;
}

export type CompanyStateReportsAdditionalPropertyRelatedChangesItemKind =
  'create' | 'modify' | 'delete';

export interface CompanyStateReportsAdditionalPropertyUsageItem {
  sessionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  role: CompanyStateReportsAdditionalPropertyUsageItemRole;
  model: string;
  provider: string;
  purpose: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  timestamp: string;
  source: CompanyStateReportsAdditionalPropertyUsageItemSource;
  availability: string;
  provenance: CompanyStateReportsAdditionalPropertyUsageItemProvenance;
  toolCallId?: string;
  runEpoch: number;
  taskId?: string;
  contractId?: string;
  totalTokens?: number;
}

export type CompanyStateReportsAdditionalPropertyUsageItemRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyStateReportsAdditionalPropertyUsageItemSource = 'provider' | 'native_session';

export type CompanyStateReportsAdditionalPropertyUsageItemProvenance =
  'own_turn' | 'native_child' | 'child_aggregate';

export interface CompanyStateReportsAdditionalPropertySessionsItem {
  sessionId: string;
  role: CompanyStateReportsAdditionalPropertySessionsItemRole;
  requestedModel: string;
  effectiveModel?: string;
  runEpoch: number;
  status: string;
}

export type CompanyStateReportsAdditionalPropertySessionsItemRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export interface CompanyStateEvidenceAdditionalProperty {
  id: string;
  command: CompanyStateEvidenceAdditionalPropertyCommand;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  signal?: string;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  prerequisites?: string[];
  criterionIds: string[];
}

export interface CompanyStateEvidenceAdditionalPropertyCommand {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface CompanyStateUsageIndexAdditionalPropertyItem {
  sessionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  role: CompanyStateUsageIndexAdditionalPropertyItemRole;
  model: string;
  provider: string;
  purpose: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  timestamp: string;
  source: CompanyStateUsageIndexAdditionalPropertyItemSource;
  availability: string;
  provenance: CompanyStateUsageIndexAdditionalPropertyItemProvenance;
  toolCallId?: string;
  runEpoch: number;
  taskId?: string;
  contractId?: string;
  totalTokens?: number;
}

export type CompanyStateUsageIndexAdditionalPropertyItemRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyStateUsageIndexAdditionalPropertyItemSource = 'provider' | 'native_session';

export type CompanyStateUsageIndexAdditionalPropertyItemProvenance =
  'own_turn' | 'native_child' | 'child_aggregate';

export interface CompanyStateQuotasAdditionalProperty {
  provider: string;
  accountLabel?: string;
  windows: CompanyStateQuotasAdditionalPropertyWindowsItem[];
  fetchedAt: string;
  status: CompanyStateQuotasAdditionalPropertyStatus;
}

export interface CompanyStateQuotasAdditionalPropertyWindowsItem {
  label: string;
  used?: number;
  remaining?: number;
  resetAt?: string;
  reportedUnit: string;
}

export type CompanyStateQuotasAdditionalPropertyStatus =
  'available' | 'unsupported' | 'unauthenticated' | 'error' | 'stale';

export interface CompanyEvent {
  id: string;
  sequence: number;
  at: string;
  baseRevision: number;
  changes: (
    | CompanyEventChangesItemOneOf_0
    | CompanyEventChangesItemOneOf_1
    | CompanyEventChangesItemOneOf_2
    | CompanyEventChangesItemOneOf_3
    | CompanyEventChangesItemOneOf_4
    | CompanyEventChangesItemOneOf_5
    | CompanyEventChangesItemOneOf_6
    | CompanyEventChangesItemOneOf_7
    | CompanyEventChangesItemOneOf_8
    | CompanyEventChangesItemOneOf_9
    | CompanyEventChangesItemOneOf_10
    | CompanyEventChangesItemOneOf_11
    | CompanyEventChangesItemOneOf_12
  )[];
}

export interface CompanyEventChangesItemOneOf_0 {
  entity: 'prompt';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_0Value;
}

export interface CompanyEventChangesItemOneOf_0Value {
  id: string;
  rawTextArtifactId: string;
  preview: string;
  createdAt: string;
  fragments: CompanyEventChangesItemOneOf_0ValueFragmentsItem[];
  attachments?: CompanyEventChangesItemOneOf_0ValueAttachmentsItem[];
  targetContractId?: string;
  targetSessionId?: string;
  routingReason?: string;
}

export interface CompanyEventChangesItemOneOf_0ValueFragmentsItem {
  id: string;
  start: number;
  end: number;
  ordinal: number;
}

export interface CompanyEventChangesItemOneOf_0ValueAttachmentsItem {
  artifactId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface CompanyEventChangesItemOneOf_1 {
  entity: 'contract';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_1Value;
}

export interface CompanyEventChangesItemOneOf_1Value {
  id: string;
  code: string;
  revision: number;
  title?: string;
  summary?: string;
  promptIds: string[];
  requirements: CompanyEventChangesItemOneOf_1ValueRequirementsItem[];
  phases: CompanyEventChangesItemOneOf_1ValuePhasesItem[];
  tasks: CompanyEventChangesItemOneOf_1ValueTasksItem[];
  assumptions: string[];
  decisions: string[];
  risks?: string[];
  acceptance: CompanyEventChangesItemOneOf_1ValueAcceptanceItem[];
  architectureReviews?: CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItem[];
  relatedFiles?: CompanyEventChangesItemOneOf_1ValueRelatedFilesItem[];
  status: CompanyEventChangesItemOneOf_1ValueStatus;
}

export interface CompanyEventChangesItemOneOf_1ValueRequirementsItem {
  id: string;
  promptId: string;
  fragmentIds: string[];
  text: string;
  kind: CompanyEventChangesItemOneOf_1ValueRequirementsItemKind;
  status: CompanyEventChangesItemOneOf_1ValueRequirementsItemStatus;
}

export type CompanyEventChangesItemOneOf_1ValueRequirementsItemKind =
  'goal' | 'constraint' | 'context';

export type CompanyEventChangesItemOneOf_1ValueRequirementsItemStatus =
  'open' | 'clarification' | 'planned' | 'satisfied' | 'blocked';

export interface CompanyEventChangesItemOneOf_1ValuePhasesItem {
  id: string;
  title: string;
  ordinal: number;
  taskIds: string[];
  acceptanceIds: string[];
}

export interface CompanyEventChangesItemOneOf_1ValueTasksItem {
  id: string;
  code: string;
  contractId: string;
  phaseId: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  workstreamId: string;
  readScopes: CompanyEventChangesItemOneOf_1ValueTasksItemReadScopesItem[];
  writeScopes: CompanyEventChangesItemOneOf_1ValueTasksItemWriteScopesItem[];
  sharedResources: string[];
  acceptance: string[];
  executionMode: CompanyEventChangesItemOneOf_1ValueTasksItemExecutionMode;
  sessionId?: string;
  status: CompanyEventChangesItemOneOf_1ValueTasksItemStatus;
  attemptIds: string[];
  routeReason: string;
  relatedFiles?: CompanyEventChangesItemOneOf_1ValueTasksItemRelatedFilesItem[];
}

export interface CompanyEventChangesItemOneOf_1ValueTasksItemReadScopesItem {
  path: string;
  kind: CompanyEventChangesItemOneOf_1ValueTasksItemReadScopesItemKind;
  operations: CompanyEventChangesItemOneOf_1ValueTasksItemReadScopesItemOperationsItem[];
}

export type CompanyEventChangesItemOneOf_1ValueTasksItemReadScopesItemKind = 'file' | 'directory';

export type CompanyEventChangesItemOneOf_1ValueTasksItemReadScopesItemOperationsItem =
  'read' | 'list' | 'search';

export interface CompanyEventChangesItemOneOf_1ValueTasksItemWriteScopesItem {
  path: string;
  kind: CompanyEventChangesItemOneOf_1ValueTasksItemWriteScopesItemKind;
  operations: CompanyEventChangesItemOneOf_1ValueTasksItemWriteScopesItemOperationsItem[];
}

export type CompanyEventChangesItemOneOf_1ValueTasksItemWriteScopesItemKind = 'file' | 'directory';

export type CompanyEventChangesItemOneOf_1ValueTasksItemWriteScopesItemOperationsItem =
  'create' | 'modify';

export type CompanyEventChangesItemOneOf_1ValueTasksItemExecutionMode =
  'inline' | 'subagent' | 'session';

export type CompanyEventChangesItemOneOf_1ValueTasksItemStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'paused'
  | 'verifying'
  | 'changes_requested'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CompanyEventChangesItemOneOf_1ValueTasksItemRelatedFilesItem {
  path: string;
  relation: CompanyEventChangesItemOneOf_1ValueTasksItemRelatedFilesItemRelation;
  reason?: string;
  artifactId?: string;
}

export type CompanyEventChangesItemOneOf_1ValueTasksItemRelatedFilesItemRelation =
  'source' | 'changed' | 'test' | 'config' | 'evidence';

export interface CompanyEventChangesItemOneOf_1ValueAcceptanceItem {
  id: string;
  requirementIds: string[];
  description: string;
  kind: CompanyEventChangesItemOneOf_1ValueAcceptanceItemKind;
  required: boolean;
}

export type CompanyEventChangesItemOneOf_1ValueAcceptanceItemKind =
  'command' | 'surface' | 'review';

export interface CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItem {
  revision: number;
  verdict: CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItemVerdict;
  issues: CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItemIssuesItem[];
  advisorNotes: string[];
  reviewedAt: string;
}

export type CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItemVerdict =
  'approve' | 'changes_requested';

export interface CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItemIssuesItem {
  severity: CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItemIssuesItemSeverity;
  requirementIds: string[];
  evidence: string[];
  fix: string;
}

export type CompanyEventChangesItemOneOf_1ValueArchitectureReviewsItemIssuesItemSeverity =
  'P0' | 'P1' | 'P2' | 'P3';

export interface CompanyEventChangesItemOneOf_1ValueRelatedFilesItem {
  path: string;
  relation: CompanyEventChangesItemOneOf_1ValueRelatedFilesItemRelation;
  reason?: string;
  artifactId?: string;
}

export type CompanyEventChangesItemOneOf_1ValueRelatedFilesItemRelation =
  'source' | 'changed' | 'test' | 'config' | 'evidence';

export type CompanyEventChangesItemOneOf_1ValueStatus =
  | 'draft'
  | 'clarifying'
  | 'architecture_review'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export interface CompanyEventChangesItemOneOf_2 {
  entity: 'task';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_2Value;
}

export interface CompanyEventChangesItemOneOf_2Value {
  id: string;
  code: string;
  contractId: string;
  phaseId: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  workstreamId: string;
  readScopes: CompanyEventChangesItemOneOf_2ValueReadScopesItem[];
  writeScopes: CompanyEventChangesItemOneOf_2ValueWriteScopesItem[];
  sharedResources: string[];
  acceptance: string[];
  executionMode: CompanyEventChangesItemOneOf_2ValueExecutionMode;
  sessionId?: string;
  status: CompanyEventChangesItemOneOf_2ValueStatus;
  attemptIds: string[];
  routeReason: string;
  relatedFiles?: CompanyEventChangesItemOneOf_2ValueRelatedFilesItem[];
}

export interface CompanyEventChangesItemOneOf_2ValueReadScopesItem {
  path: string;
  kind: CompanyEventChangesItemOneOf_2ValueReadScopesItemKind;
  operations: CompanyEventChangesItemOneOf_2ValueReadScopesItemOperationsItem[];
}

export type CompanyEventChangesItemOneOf_2ValueReadScopesItemKind = 'file' | 'directory';

export type CompanyEventChangesItemOneOf_2ValueReadScopesItemOperationsItem =
  'read' | 'list' | 'search';

export interface CompanyEventChangesItemOneOf_2ValueWriteScopesItem {
  path: string;
  kind: CompanyEventChangesItemOneOf_2ValueWriteScopesItemKind;
  operations: CompanyEventChangesItemOneOf_2ValueWriteScopesItemOperationsItem[];
}

export type CompanyEventChangesItemOneOf_2ValueWriteScopesItemKind = 'file' | 'directory';

export type CompanyEventChangesItemOneOf_2ValueWriteScopesItemOperationsItem = 'create' | 'modify';

export type CompanyEventChangesItemOneOf_2ValueExecutionMode = 'inline' | 'subagent' | 'session';

export type CompanyEventChangesItemOneOf_2ValueStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'paused'
  | 'verifying'
  | 'changes_requested'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CompanyEventChangesItemOneOf_2ValueRelatedFilesItem {
  path: string;
  relation: CompanyEventChangesItemOneOf_2ValueRelatedFilesItemRelation;
  reason?: string;
  artifactId?: string;
}

export type CompanyEventChangesItemOneOf_2ValueRelatedFilesItemRelation =
  'source' | 'changed' | 'test' | 'config' | 'evidence';

export interface CompanyEventChangesItemOneOf_3 {
  entity: 'session';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_3Value;
}

export interface CompanyEventChangesItemOneOf_3Value {
  id: string;
  code: string;
  name: string;
  role: CompanyEventChangesItemOneOf_3ValueRole;
  workstreamId: string;
  workspaceKey: string;
  requestedModel: string;
  effectiveModel?: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
  agentId?: number;
  runEpoch: number;
  status: CompanyEventChangesItemOneOf_3ValueStatus;
  activeTaskId?: string;
  lastUsedAt: string;
  contextSnapshot?: Record<string, any>;
  handoffArtifactId?: string;
}

export type CompanyEventChangesItemOneOf_3ValueRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyEventChangesItemOneOf_3ValueStatus =
  | 'parked'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'waiting_input'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'archived';

export interface CompanyEventChangesItemOneOf_4 {
  entity: 'question';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_4Value;
}

export interface CompanyEventChangesItemOneOf_4Value {
  id: string;
  sessionId: string;
  taskId?: string;
  runEpoch: number;
  nativeToolCallId?: string;
  kind: CompanyEventChangesItemOneOf_4ValueKind;
  title: string;
  questions: CompanyEventChangesItemOneOf_4ValueQuestionsItem[];
  actionDigest?: string;
  status: CompanyEventChangesItemOneOf_4ValueStatus;
  answer?: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export type CompanyEventChangesItemOneOf_4ValueKind =
  'clarification' | 'technical_choice' | 'approval';

export interface CompanyEventChangesItemOneOf_4ValueQuestionsItem {
  id: string;
  question: string;
  options: CompanyEventChangesItemOneOf_4ValueQuestionsItemOptionsItem[];
  recommended?: number;
  multi?: boolean;
}

export interface CompanyEventChangesItemOneOf_4ValueQuestionsItemOptionsItem {
  label: string;
  description?: string;
}

export type CompanyEventChangesItemOneOf_4ValueStatus =
  'pending' | 'answered' | 'rejected' | 'cancelled' | 'expired';

export interface CompanyEventChangesItemOneOf_5 {
  entity: 'attempt';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_5Value;
}

export interface CompanyEventChangesItemOneOf_5Value {
  id: string;
  taskId: string;
  sessionId: string;
  runEpoch: number;
  startedAt: string;
  endedAt?: string;
  status: CompanyEventChangesItemOneOf_5ValueStatus;
  changes: CompanyEventChangesItemOneOf_5ValueChangesItem[];
  evidenceIds: string[];
  qaVerdict?: Record<string, any>;
  judgeVerdict?: Record<string, any>;
  error?: string;
}

export type CompanyEventChangesItemOneOf_5ValueStatus =
  'running' | 'passed' | 'failed' | 'interrupted' | 'blocked';

export interface CompanyEventChangesItemOneOf_5ValueChangesItem {
  path: string;
  kind: CompanyEventChangesItemOneOf_5ValueChangesItemKind;
  summary: string;
  diffArtifactId?: string;
}

export type CompanyEventChangesItemOneOf_5ValueChangesItemKind = 'create' | 'modify' | 'delete';

export interface CompanyEventChangesItemOneOf_6 {
  entity: 'report';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_6Value;
}

export interface CompanyEventChangesItemOneOf_6Value {
  contractId: string;
  revision: number;
  requirements: CompanyEventChangesItemOneOf_6ValueRequirementsItem[];
  relatedChanges: CompanyEventChangesItemOneOf_6ValueRelatedChangesItem[];
  verificationEvidenceIds: string[];
  advisorNotes: string[];
  usage: CompanyEventChangesItemOneOf_6ValueUsageItem[];
  sessions: CompanyEventChangesItemOneOf_6ValueSessionsItem[];
}

export interface CompanyEventChangesItemOneOf_6ValueRequirementsItem {
  requirementId: string;
  taskIds: string[];
  attemptIds: string[];
  evidenceIds: string[];
  result: string;
}

export interface CompanyEventChangesItemOneOf_6ValueRelatedChangesItem {
  path: string;
  kind: CompanyEventChangesItemOneOf_6ValueRelatedChangesItemKind;
  summary: string;
  diffArtifactId?: string;
}

export type CompanyEventChangesItemOneOf_6ValueRelatedChangesItemKind =
  'create' | 'modify' | 'delete';

export interface CompanyEventChangesItemOneOf_6ValueUsageItem {
  sessionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  role: CompanyEventChangesItemOneOf_6ValueUsageItemRole;
  model: string;
  provider: string;
  purpose: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  timestamp: string;
  source: CompanyEventChangesItemOneOf_6ValueUsageItemSource;
  availability: string;
  provenance: CompanyEventChangesItemOneOf_6ValueUsageItemProvenance;
  toolCallId?: string;
  runEpoch: number;
  taskId?: string;
  contractId?: string;
  totalTokens?: number;
}

export type CompanyEventChangesItemOneOf_6ValueUsageItemRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyEventChangesItemOneOf_6ValueUsageItemSource = 'provider' | 'native_session';

export type CompanyEventChangesItemOneOf_6ValueUsageItemProvenance =
  'own_turn' | 'native_child' | 'child_aggregate';

export interface CompanyEventChangesItemOneOf_6ValueSessionsItem {
  sessionId: string;
  role: CompanyEventChangesItemOneOf_6ValueSessionsItemRole;
  requestedModel: string;
  effectiveModel?: string;
  runEpoch: number;
  status: string;
}

export type CompanyEventChangesItemOneOf_6ValueSessionsItemRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export interface CompanyEventChangesItemOneOf_7 {
  entity: 'evidence';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_7Value;
}

export interface CompanyEventChangesItemOneOf_7Value {
  id: string;
  command: CompanyEventChangesItemOneOf_7ValueCommand;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  signal?: string;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  prerequisites?: string[];
  criterionIds: string[];
}

export interface CompanyEventChangesItemOneOf_7ValueCommand {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface CompanyEventChangesItemOneOf_8 {
  entity: 'settings';
  op: 'put';
  id: 'settings';
  value: CompanyEventChangesItemOneOf_8Value;
}

export interface CompanyEventChangesItemOneOf_8Value {
  workspacePath: string;
  maxRetainedSessions: 10;
  maxLiveRunners: 4;
  maxConcurrentModelCalls: 4;
  maxWorkers: 4;
  idleParkSeconds: 120;
  roleProfiles: Record<string, CompanyEventChangesItemOneOf_8ValueRoleProfilesAdditionalProperty>;
  verificationProfiles: Record<
    string,
    CompanyEventChangesItemOneOf_8ValueVerificationProfilesAdditionalProperty
  >;
}

export interface CompanyEventChangesItemOneOf_8ValueRoleProfilesAdditionalProperty {
  role: CompanyEventChangesItemOneOf_8ValueRoleProfilesAdditionalPropertyRole;
  requestedModel: string;
  thinking: string;
  workflowFingerprint: string;
  toolsPolicy: CompanyEventChangesItemOneOf_8ValueRoleProfilesAdditionalPropertyToolsPolicy;
}

export type CompanyEventChangesItemOneOf_8ValueRoleProfilesAdditionalPropertyRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyEventChangesItemOneOf_8ValueRoleProfilesAdditionalPropertyToolsPolicy =
  'read-only' | 'scoped-write' | 'verification-only';

export interface CompanyEventChangesItemOneOf_8ValueVerificationProfilesAdditionalProperty {
  id: string;
  criterionIds: string[];
  commands: CompanyEventChangesItemOneOf_8ValueVerificationProfilesAdditionalPropertyCommandsItem[];
  prerequisites: string[];
  outputScopes: string[];
}

export interface CompanyEventChangesItemOneOf_8ValueVerificationProfilesAdditionalPropertyCommandsItem {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface CompanyEventChangesItemOneOf_9 {
  entity: 'usage';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_9Value;
}

export interface CompanyEventChangesItemOneOf_9Value {
  sessionId: string;
  nativeSessionId: string;
  nativeEntryId: string;
  role: CompanyEventChangesItemOneOf_9ValueRole;
  model: string;
  provider: string;
  purpose: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  timestamp: string;
  source: CompanyEventChangesItemOneOf_9ValueSource;
  availability: string;
  provenance: CompanyEventChangesItemOneOf_9ValueProvenance;
  toolCallId?: string;
  runEpoch: number;
  taskId?: string;
  contractId?: string;
  totalTokens?: number;
}

export type CompanyEventChangesItemOneOf_9ValueRole =
  'director' | 'advisor' | 'worker' | 'qa' | 'judge';

export type CompanyEventChangesItemOneOf_9ValueSource = 'provider' | 'native_session';

export type CompanyEventChangesItemOneOf_9ValueProvenance =
  'own_turn' | 'native_child' | 'child_aggregate';

export interface CompanyEventChangesItemOneOf_10 {
  entity: 'quota';
  op: 'put';
  id: string;
  value: CompanyEventChangesItemOneOf_10Value;
}

export interface CompanyEventChangesItemOneOf_10Value {
  provider: string;
  accountLabel?: string;
  windows: CompanyEventChangesItemOneOf_10ValueWindowsItem[];
  fetchedAt: string;
  status: CompanyEventChangesItemOneOf_10ValueStatus;
}

export interface CompanyEventChangesItemOneOf_10ValueWindowsItem {
  label: string;
  used?: number;
  remaining?: number;
  resetAt?: string;
  reportedUnit: string;
}

export type CompanyEventChangesItemOneOf_10ValueStatus =
  'available' | 'unsupported' | 'unauthenticated' | 'error' | 'stale';

export interface CompanyEventChangesItemOneOf_11 {
  entity: 'counters';
  op: 'put';
  id: 'counters';
  value: CompanyEventChangesItemOneOf_11Value;
}

export interface CompanyEventChangesItemOneOf_11Value {
  session: number;
  task: number;
  contract: number;
}

export interface CompanyEventChangesItemOneOf_12 {
  entity: CompanyEventChangesItemOneOf_12Entity;
  op: 'remove';
  id: string;
}

export type CompanyEventChangesItemOneOf_12Entity =
  | 'prompt'
  | 'contract'
  | 'task'
  | 'session'
  | 'question'
  | 'attempt'
  | 'report'
  | 'evidence'
  | 'usage'
  | 'quota';
