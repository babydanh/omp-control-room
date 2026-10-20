/**
 * The JSON Schema of the judge's reply, passed to `claude -p --json-schema`. It mirrors what
 * `parseJudgeReply` in `judgeModel.ts` accepts, field for field. The parser ignores keys it does
 * not read, so this schema leaves extra keys open. The rule that a non-pass verdict needs a
 * follow-up spans two fields, so the parser keeps it.
 */

import { JUDGE_FOLLOW_UP_MAX_CHARS } from './judgeModel.js';
import { JUDGE_REASON_MAX_CHARS, JUDGE_VERDICTS } from './workItemModel.js';

export const JUDGE_REPLY_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['verdict', 'reason', 'followUp'],
  properties: {
    verdict: {
      type: 'string',
      enum: [...JUDGE_VERDICTS],
      description: 'One of pass, fail or need_evidence.',
    },
    reason: {
      type: 'string',
      pattern: '\\S',
      maxLength: JUDGE_REASON_MAX_CHARS,
      description: 'One short sentence.',
    },
    followUp: {
      type: 'string',
      maxLength: JUDGE_FOLLOW_UP_MAX_CHARS,
      description: 'What the worker must do next. Empty only for a pass.',
    },
  },
} as const;
