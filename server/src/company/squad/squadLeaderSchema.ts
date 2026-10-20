/**
 * The JSON Schema of the squad leader's reply, passed to `claude -p --json-schema`. It mirrors
 * what `parseLeaderReply` in `squadModel.ts` accepts, field for field: the same required keys, the
 * same closed sets, and the same limits the parser checks on the raw value. Every reply this schema
 * accepts is one the parser accepts. The parser also checks what a JSON Schema cannot see from the
 * reply alone: a repo or agent must be in the catalog, an assignee must be a listed member, a `#n`
 * must be an open item, dependencies must not loop, and `done` must agree with `assignments`.
 */

import {
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_MAX,
  WORK_ITEM_PRIORITY_MIN,
} from '../../../../core/src/workItemGraph.js';
import { WORK_ITEM_AREAS_MAX } from '../workItems/workItemModel.js';
import { SQUAD_MAX_ROWS } from './squadModel.js';

/** A `#n` reference to an open work item, in the form the parser reads. */
export const SEQUENCE_REF_PATTERN = '^#[1-9]\\d*$';

/** A text with at least one non-whitespace character, as the parser's trimmed-empty check needs. */
const NON_BLANK_PATTERN = '\\S';

const ASSIGNMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    assignee: {
      type: 'string',
      description:
        'An id listed under Team, "auto" (the scheduler picks a free agent), "new-session" (a fresh omp chat), or "claude" (a Claude Code run). Omitted means "auto".',
    },
    text: {
      type: 'string',
      pattern: NON_BLANK_PATTERN,
      description: 'The prompt the assignee will run.',
    },
    reason: { type: 'string', description: 'One short sentence.' },
    priority: {
      type: 'integer',
      minimum: WORK_ITEM_PRIORITY_MIN,
      maximum: WORK_ITEM_PRIORITY_MAX,
      description: '0 is most urgent, 3 is least. Omitted means 2.',
    },
    acceptance: {
      type: 'string',
      maxLength: WORK_ITEM_ACCEPTANCE_MAX_CHARS,
      description: 'What done means for this row.',
    },
    dependsOn: {
      type: 'array',
      maxItems: WORK_ITEM_DEPENDS_MAX,
      description:
        '0-based positions of other rows in this reply, or "#n" of an open work item the reply was shown.',
      items: {
        anyOf: [
          { type: 'integer', minimum: 0 },
          { type: 'string', pattern: SEQUENCE_REF_PATTERN },
        ],
      },
    },
    repo: {
      type: 'string',
      description: 'One of the paths under Repos. Omitted means the folder root.',
    },
    role: {
      type: 'string',
      enum: ['advisor', 'worker', 'qa', 'judge', 'chat'],
      description: 'Omitted means no role.',
    },
    agent: {
      type: 'string',
      description: 'One name under Agents. Omitted means the default worker.',
    },
    areas: {
      type: 'array',
      maxItems: WORK_ITEM_AREAS_MAX,
      description: 'Lowercase code areas the row edits, such as web:src/app.',
      items: { type: 'string' },
    },
  },
} as const;

export const SQUAD_LEADER_REPLY_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['assignments', 'note', 'done'],
  properties: {
    assignments: {
      type: 'array',
      maxItems: SQUAD_MAX_ROWS,
      items: ASSIGNMENT_SCHEMA,
    },
    note: {
      type: 'string',
      description: 'One short sentence for the user, in the language of the request.',
    },
    done: {
      type: 'boolean',
      description: 'True only when the request is complete. Then assignments is [].',
    },
  },
} as const;
