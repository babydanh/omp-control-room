/**
 * contextRouter: where a submitted prompt belongs.
 *
 * A prompt the user pastes at the company has to land somewhere, and the
 * interesting part is refusing the easy wrong answer. Reusing a context because
 * it shares a workspace, or because its title looks close, silently drags an
 * unrelated request into a session that already holds another Contract's
 * reasoning -- and the worker then "fixes" something nobody asked for. So the
 * ladder below only ever reuses on an EXACT relation that already exists in the
 * durable records:
 *
 *   1. an explicit `targetSessionId`, when that session is live and the
 *      Contract behind it is one the user actually approved;
 *   2. an explicit `targetContractId`, when that Contract exists and is live;
 *   3. a relation the Director proposed and the validator already accepted
 *      (contract + workstream, matched by id, never by text);
 *   4. otherwise a brand new workstream opened at the Director.
 *
 * Nothing here reads the prompt text, so no model is asked to guess. A rejected
 * target is reported rather than swallowed, because the composer shows the
 * reason and lets the user retarget before anything is dispatched.
 *
 * The gate that matters for safety is the Contract status: a role that executes
 * or judges work (worker, qa, judge) only ever receives a prompt when the
 * Contract it belongs to is approved or running. Planning roles (director,
 * advisor) legitimately work on contracts that are still drafts, so a draft is
 * not an obstacle for them.
 *
 * Chat prompts (`mode: 'chat'`) work like typing into the user's own omp. They
 * never attach to a Contract and never reach the Director. A named session is
 * honoured or refused; with none named, the prompt opens a new plain chat
 * session. A refused target is never swapped for a new session.
 */

import type {
  CompanyRole,
  CompanySession,
  Contract,
  SubmitPromptInput,
} from '../../../core/src/company.js';
import {
  CONTRACT_STATUS_LABELS,
  PROMPT_DELIVERY_LABELS,
  SESSION_STATUS_LABELS,
} from './labels.js';

export const ROUTE_STRATEGIES = [
  'explicit_session',
  'explicit_contract',
  'approved_workstream',
  'new_workstream',
  'new_chat',
  'undeliverable',
] as const;
export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

export type RouteRejectionCode =
  | 'target_session_unknown'
  | 'target_session_not_routable'
  | 'target_session_contract_not_active'
  | 'target_contract_unknown'
  | 'target_contract_not_active'
  | 'relation_contract_unknown'
  | 'relation_contract_not_active'
  | 'relation_workstream_unknown';

export interface RouteRejection {
  code: RouteRejectionCode;
  message: string;
}

/** A Director-proposed link between a prompt and a Contract, already validated. */
export interface AcceptedRelation {
  contractId: string;
  workstreamId: string;
}

export interface RouteInput {
  /** `chat` prompts take the chat path below; anything else follows the Contract ladder. */
  mode?: SubmitPromptInput['mode'];
  delivery: SubmitPromptInput['delivery'];
  targetContractId?: string;
  targetSessionId?: string;
  contracts: readonly Contract[];
  sessions: readonly CompanySession[];
  acceptedRelation?: AcceptedRelation | null;
}

export interface RouteDecision {
  strategy: RouteStrategy;
  /** Role that must handle the prompt next. */
  role: CompanyRole;
  /** True when the prompt opens a workstream no Contract covers yet. */
  newWorkstream: boolean;
  /** Existing session that receives the prompt, when one can. */
  targetSessionId?: string;
  /** Contract the prompt is attached to, when one applies. */
  targetContractId?: string;
  /** Workstream the prompt belongs to; absent while the Director still picks one. */
  workstreamId?: string;
  /** Sentence the board shows verbatim before dispatch. */
  reason: string;
  /** Every explicit target that was refused, in the order it was considered. */
  rejected: RouteRejection[];
}

type ContractStatus = Contract['status'];
type SessionStatus = CompanySession['status'];

/** Statuses in which a Contract is still the live definition of the work. */
const ACTIVE_CONTRACT_STATUSES: Partial<Record<ContractStatus, true>> = {
  approved: true,
  running: true,
};

/** Statuses in which a session takes a prompt without an explicit restart first. */
const ROUTABLE_SESSION_STATUSES: Partial<Record<SessionStatus, true>> = {
  parked: true,
  starting: true,
  idle: true,
  busy: true,
  waiting_input: true,
};

/** Roles that act on the work itself; they may only ever run approved work. */
const EXECUTION_ROLES: Partial<Record<CompanyRole, true>> = {
  worker: true,
  qa: true,
  judge: true,
};

function workstreamIdsOf(contract: Contract): Set<string> {
  return new Set(contract.tasks.map((entry) => entry.workstreamId));
}

function activeContractStatus(status: ContractStatus): boolean {
  return ACTIVE_CONTRACT_STATUSES[status] === true;
}

function routableSessionStatus(status: SessionStatus): boolean {
  return ROUTABLE_SESSION_STATUSES[status] === true;
}

/**
 * The Contract a session belongs to, found through the exact links the records
 * hold: a task bound to the session, or a task in the session's workstream.
 * When several match, the active one wins so a stale draft never shadows the
 * Contract the work is really running under.
 */
function contractOfSession(
  session: CompanySession,
  contracts: readonly Contract[],
): Contract | undefined {
  const ranked = contracts
    .filter((contract) =>
      contract.tasks.some(
        (task) => task.sessionId === session.id || task.workstreamId === session.workstreamId,
      ),
    )
    .sort((left, right) => {
      const active =
        Number(activeContractStatus(right.status)) - Number(activeContractStatus(left.status));
      return active !== 0 ? active : left.code.localeCompare(right.code);
    });
  return ranked[0];
}

/** The newest live Director session of a workstream, which owns prompt intake. */
function mostRecentDirector(
  sessions: readonly CompanySession[],
  workstreamId: string | undefined,
): CompanySession | undefined {
  if (workstreamId === undefined) return undefined;
  return sessions
    .filter((session) => session.role === 'director' && session.workstreamId === workstreamId)
    .filter((session) => routableSessionStatus(session.status))
    .sort(
      (left, right) =>
        right.lastUsedAt.localeCompare(left.lastUsedAt) || left.code.localeCompare(right.code),
    )[0];
}

/** Human-readable Contract status. The wire value is an English enum that
 *  reads badly mid-sentence (`awaiting_approval`), so map it to a label. */
function describeStatus(status: ContractStatus): string {
  return CONTRACT_STATUS_LABELS[status] ?? status;
}

/**
 * Gate one explicit session target. Returns the refusal, or undefined when the
 * session may receive the prompt.
 */
function refuseSession(
  session: CompanySession | undefined,
  sessionId: string,
  contract: Contract | undefined,
): RouteRejection | undefined {
  if (!session) {
    return {
      code: 'target_session_unknown',
      message: `Phiên ${sessionId} không tồn tại, nên prompt không được chuyển tới đó.`,
    };
  }
  if (!routableSessionStatus(session.status)) {
    return {
      code: 'target_session_not_routable',
      message: `Phiên ${session.code} đang ${SESSION_STATUS_LABELS[session.status] ?? session.status}; hãy tiếp tục hoặc khởi động lại trước khi gửi prompt.`,
    };
  }
  if (contract?.status === 'cancelled') {
    return {
      code: 'target_session_contract_not_active',
      message: `Phiên ${session.code} thuộc về hợp đồng ${contract.code} đã bị hủy.`,
    };
  }
  if (EXECUTION_ROLES[session.role] !== true) return undefined;

  if (!contract) {
    return {
      code: 'target_session_contract_not_active',
      message: `Phiên ${session.code} không có hợp đồng đã duyệt nào đứng sau nó, nên không có công việc nào được chuyển tới.`,
    };
  }
  if (!activeContractStatus(contract.status)) {
    return {
      code: 'target_session_contract_not_active',
      message: `Hợp đồng ${contract.code} đang ${describeStatus(contract.status)}, nên ${session.code} không nhận được gì.`,
    };
  }
  return undefined;
}

function refuseContract(
  contract: Contract | undefined,
  contractId: string,
): RouteRejection | undefined {
  if (!contract) {
    return {
      code: 'target_contract_unknown',
      message: `Hợp đồng ${contractId} không tồn tại, nên prompt không được gắn vào đó.`,
    };
  }
  if (contract.status === 'cancelled') {
    return {
      code: 'target_contract_not_active',
      message: `Hợp đồng ${contract.code} đã bị hủy và không thể nhận công việc mới.`,
    };
  }
  return undefined;
}

/** The workstream an explicit Contract target names, without guessing between many. */
function workstreamForContract(
  contract: Contract,
  relation: AcceptedRelation | null | undefined,
): string | undefined {
  const streams = workstreamIdsOf(contract);
  if (relation && relation.contractId === contract.id && streams.has(relation.workstreamId)) {
    return relation.workstreamId;
  }
  return streams.size === 1 ? [...streams][0] : undefined;
}

function withRejections(reason: string, rejected: RouteRejection[]): string {
  if (rejected.length === 0) return reason;
  return `${reason} Refused: ${rejected.map((entry) => entry.message).join(' ')}`;
}

/**
 * Decide a chat prompt. Chat never attaches to a Contract and never reaches the
 * Director, so the only question is which session, if any, receives it. A named
 * session is honoured or refused; a refused target is never replaced by a new
 * session, because the user named one on purpose.
 */
function routeChatPrompt(input: RouteInput): RouteDecision {
  const rejected: RouteRejection[] = [];
  if (input.targetSessionId !== undefined) {
    const session = input.sessions.find((entry) => entry.id === input.targetSessionId);
    const contract = session ? contractOfSession(session, input.contracts) : undefined;
    const refusal = refuseSession(session, input.targetSessionId, contract);
    if (refusal) rejected.push(refusal);
    else if (session) {
      return {
        strategy: 'explicit_session',
        role: session.role,
        newWorkstream: false,
        targetSessionId: session.id,
        ...(contract ? { targetContractId: contract.id } : {}),
        workstreamId: session.workstreamId,
        reason: `Prompt gửi tới phiên ${session.code} mà bạn đã chọn.`,
        rejected: [],
      };
    }
  }

  // Steering and follow-ups address a run that exists, so without a resolved
  // session they cannot be delivered. A refused target is never replaced.
  if (rejected.length > 0 || input.delivery !== 'prompt') {
    const base =
      rejected.length > 0
        ? 'Prompt không được gửi vì phiên bạn chọn không nhận được nó.'
        : `Prompt ${PROMPT_DELIVERY_LABELS[input.delivery] ?? input.delivery} cần một phiên đang hoạt động để gửi tới, và chưa chọn phiên nào.`;
    return {
      strategy: 'undeliverable',
      role: 'chat',
      newWorkstream: false,
      reason: withRejections(base, rejected),
      rejected,
    };
  }

  return {
    strategy: 'new_chat',
    role: 'chat',
    newWorkstream: false,
    reason: 'Mở một phiên omp trò chuyện mới trong thư mục này.',
    rejected: [],
  };
}

/**
 * Decide where a prompt goes. Pure: it reads the records it is handed, starts
 * nothing, and never looks at the prompt body.
 */
export function routePrompt(input: RouteInput): RouteDecision {
  if (input.mode === 'chat') return routeChatPrompt(input);
  const rejected: RouteRejection[] = [];
  const candidate = resolveTarget(input, rejected);

  // Steering and follow-ups address a run that already exists. With no live
  // session resolved, delivering them anywhere would be a guess, so they are
  // refused instead of being turned into a new workstream.
  if (input.delivery !== 'prompt' && candidate?.targetSessionId === undefined) {
    return {
      strategy: 'undeliverable',
      role: 'director',
      newWorkstream: false,
      reason: withRejections(
        `Prompt ${PROMPT_DELIVERY_LABELS[input.delivery] ?? input.delivery} cần một phiên đang hoạt động để gửi tới, và không có phiên nào được chỉ định hay tìm thấy.`,
        rejected,
      ),
      rejected,
    };
  }

  if (candidate) return { ...candidate, rejected: [] };

  return {
    strategy: 'new_workstream',
    role: 'director',
    newWorkstream: true,
    reason: withRejections(
      'Không có hợp đồng hay workstream đã duyệt nào khớp với prompt này, nên Director mở một workstream mới.',
      rejected,
    ),
    rejected,
  };
}

/**
 * Walk the precedence ladder and return the first destination it accepts.
 * Refused targets are appended to `rejected` so the reason can explain them.
 */
function resolveTarget(
  input: RouteInput,
  rejected: RouteRejection[],
): Omit<RouteDecision, 'rejected'> | undefined {
  const { contracts, sessions } = input;

  if (input.targetSessionId !== undefined) {
    const session = sessions.find((entry) => entry.id === input.targetSessionId);
    const contract = session ? contractOfSession(session, contracts) : undefined;
    const refusal = refuseSession(session, input.targetSessionId, contract);
    if (refusal) rejected.push(refusal);
    else if (session) {
      return {
        strategy: 'explicit_session',
        role: session.role,
        newWorkstream: false,
        targetSessionId: session.id,
        ...(contract ? { targetContractId: contract.id } : {}),
        workstreamId: session.workstreamId,
        reason: contract
          ? `Prompt goes to the session the user named, ${session.code} (${session.role}), in workstream ${session.workstreamId} of contract ${contract.code}.`
          : `Prompt goes to the session the user named, ${session.code} (${session.role}), in workstream ${session.workstreamId}.`,
      };
    }
  }

  if (input.targetContractId !== undefined) {
    const contract = contracts.find((entry) => entry.id === input.targetContractId);
    const refusal = refuseContract(contract, input.targetContractId);
    if (refusal) rejected.push(refusal);
    else if (contract) {
      const workstreamId = workstreamForContract(contract, input.acceptedRelation);
      const director = mostRecentDirector(sessions, workstreamId);
      return {
        strategy: 'explicit_contract',
        role: 'director',
        newWorkstream: false,
        targetContractId: contract.id,
        ...(workstreamId === undefined ? {} : { workstreamId }),
        ...(director ? { targetSessionId: director.id } : {}),
        reason: workstreamId
          ? `Prompt joins contract ${contract.code} (${describeStatus(contract.status)}) in workstream ${workstreamId}.`
          : `Prompt joins contract ${contract.code} (${describeStatus(contract.status)}); the Director picks the workstream.`,
      };
    }
  }

  const relation = input.acceptedRelation;
  if (!relation) return undefined;

  const contract = contracts.find((entry) => entry.id === relation.contractId);
  if (!contract) {
    rejected.push({
      code: 'relation_contract_unknown',
      message: `Quan hệ được đề xuất nhắc tới hợp đồng ${relation.contractId}, vốn không tồn tại.`,
    });
    return undefined;
  }
  if (!activeContractStatus(contract.status)) {
    rejected.push({
      code: 'relation_contract_not_active',
      message: `Hợp đồng ${contract.code} đang ${describeStatus(contract.status)}, nên workstream ${relation.workstreamId} chưa được tham gia.`,
    });
    return undefined;
  }
  if (!workstreamIdsOf(contract).has(relation.workstreamId)) {
    rejected.push({
      code: 'relation_workstream_unknown',
      message: `Hợp đồng ${contract.code} không có workstream ${relation.workstreamId}.`,
    });
    return undefined;
  }

  const director = mostRecentDirector(sessions, relation.workstreamId);
  return {
    strategy: 'approved_workstream',
    role: 'director',
    newWorkstream: false,
    targetContractId: contract.id,
    workstreamId: relation.workstreamId,
    ...(director ? { targetSessionId: director.id } : {}),
    reason: `Prompt tham gia hợp đồng đã duyệt ${contract.code} (${describeStatus(contract.status)}) trong workstream ${relation.workstreamId}.`,
  };
}
