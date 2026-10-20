import { describe, expect, it } from 'vitest';

import {
  buildJudgePrompt,
  decideJudgeAction,
  EVIDENCE_REQUEST,
  JUDGE_FOLLOW_UP_MAX_CHARS,
  JUDGE_REPLY_ERROR,
  JUDGE_REPLY_MAX_CHARS,
  JUDGE_RESULT_MAX_CHARS,
  type JudgeInput,
  type JudgeReply,
  notMetReason,
  parseJudgeReply,
} from '../src/company/workItems/judgeModel.js';
import {
  JUDGE_MAX_FOLLOW_UPS,
  JUDGE_REASON_MAX_CHARS,
} from '../src/company/workItems/workItemModel.js';

describe('parseJudgeReply', () => {
  it('reads a pass reply and keeps an empty follow-up empty', () => {
    expect(parseJudgeReply('{"verdict":"pass","reason":"Đạt đủ.","followUp":""}')).toEqual({
      ok: true,
      reply: { verdict: 'pass', reason: 'Đạt đủ.', followUp: '' },
    });
  });

  it('accepts the reply when the model wraps it in a json fence', () => {
    const raw = '```json\n{"verdict":"fail","reason":"Thiếu test.","followUp":"Thêm test."}\n```';
    expect(parseJudgeReply(raw)).toEqual({
      ok: true,
      reply: { verdict: 'fail', reason: 'Thiếu test.', followUp: 'Thêm test.' },
    });
  });

  it('refuses text that is not JSON', () => {
    expect(parseJudgeReply('Đạt rồi')).toEqual({ ok: false, error: JUDGE_REPLY_ERROR.notJson });
  });

  it('refuses a JSON value that is not an object', () => {
    expect(parseJudgeReply('"pass"')).toEqual({ ok: false, error: JUDGE_REPLY_ERROR.shape });
  });

  it('refuses an unknown verdict and names it in the error', () => {
    expect(parseJudgeReply('{"verdict":"maybe","reason":"x","followUp":"y"}')).toEqual({
      ok: false,
      error: 'Giám khảo trả verdict không hợp lệ: maybe.',
    });
  });

  it('refuses a reply with no verdict at all', () => {
    expect(parseJudgeReply('{"reason":"x","followUp":"y"}')).toEqual({
      ok: false,
      error: 'Giám khảo trả verdict không hợp lệ: không có.',
    });
  });

  it('refuses a missing or blank reason', () => {
    const blank = parseJudgeReply('{"verdict":"pass","reason":"   ","followUp":""}');
    expect(blank).toEqual({ ok: false, error: JUDGE_REPLY_ERROR.reasonMissing });
    expect(parseJudgeReply('{"verdict":"pass","followUp":""}')).toEqual({
      ok: false,
      error: JUDGE_REPLY_ERROR.reasonMissing,
    });
  });

  it('refuses a fail or need_evidence that names no follow-up', () => {
    expect(parseJudgeReply('{"verdict":"fail","reason":"Hỏng.","followUp":" "}')).toEqual({
      ok: false,
      error: JUDGE_REPLY_ERROR.followUpMissing,
    });
  });

  it('refuses a reply longer than the reply limit before it is parsed', () => {
    const raw = `{"verdict":"pass","reason":"ok","followUp":"${'x'.repeat(JUDGE_REPLY_MAX_CHARS)}"}`;
    expect(parseJudgeReply(raw)).toEqual({ ok: false, error: JUDGE_REPLY_ERROR.oversize });
  });

  it('refuses a reason longer than the reason limit', () => {
    const reason = 'r'.repeat(JUDGE_REASON_MAX_CHARS + 1);
    expect(parseJudgeReply(`{"verdict":"pass","reason":"${reason}","followUp":""}`)).toEqual({
      ok: false,
      error: JUDGE_REPLY_ERROR.reasonLong,
    });
  });

  it('refuses a follow-up longer than the follow-up limit', () => {
    const followUp = 'x'.repeat(JUDGE_FOLLOW_UP_MAX_CHARS + 1);
    expect(parseJudgeReply(`{"verdict":"fail","reason":"Hỏng.","followUp":"${followUp}"}`)).toEqual(
      {
        ok: false,
        error: JUDGE_REPLY_ERROR.followUpLong,
      },
    );
  });

  it('trims the reason and follow-up it keeps', () => {
    expect(
      parseJudgeReply('{"verdict":"fail","reason":"  Hỏng. ","followUp":"  Sửa đi.  "}'),
    ).toEqual({ ok: true, reply: { verdict: 'fail', reason: 'Hỏng.', followUp: 'Sửa đi.' } });
  });
});

describe('decideJudgeAction', () => {
  const pass: JudgeReply = { verdict: 'pass', reason: 'Đạt.', followUp: '' };
  const fail: JudgeReply = { verdict: 'fail', reason: 'Thiếu test.', followUp: 'Thêm test.' };
  const needEvidence: JudgeReply = {
    verdict: 'need_evidence',
    reason: 'Chưa có lệnh.',
    followUp: 'Chạy lệnh test.',
  };

  it('settles a pass without sending anything', () => {
    expect(decideJudgeAction(pass, { followUps: 0, evidenceAsked: false })).toEqual({
      kind: 'pass',
    });
  });

  it('sends the judge follow-up for a fail while follow-ups remain', () => {
    expect(decideJudgeAction(fail, { followUps: 0, evidenceAsked: false })).toEqual({
      kind: 'follow_up',
      text: 'Thêm test.',
      evidenceAsked: false,
    });
  });

  it('asks for evidence once on need_evidence and keeps the judge follow-up with it', () => {
    expect(decideJudgeAction(needEvidence, { followUps: 0, evidenceAsked: false })).toEqual({
      kind: 'follow_up',
      text: `${EVIDENCE_REQUEST} Chạy lệnh test.`,
      evidenceAsked: true,
    });
  });

  it('counts a second need_evidence as a fail and sends its follow-up', () => {
    expect(decideJudgeAction(needEvidence, { followUps: 1, evidenceAsked: true })).toEqual({
      kind: 'follow_up',
      text: 'Chạy lệnh test.',
      evidenceAsked: true,
    });
  });

  it('moves to the user once the judge follow-ups are used up', () => {
    expect(
      decideJudgeAction(fail, { followUps: JUDGE_MAX_FOLLOW_UPS, evidenceAsked: false }),
    ).toEqual({ kind: 'needs_input', reason: notMetReason('Thiếu test.') });
  });

  it('moves to the user on need_evidence once the follow-ups are used up', () => {
    expect(
      decideJudgeAction(needEvidence, { followUps: JUDGE_MAX_FOLLOW_UPS, evidenceAsked: true }),
    ).toEqual({ kind: 'needs_input', reason: notMetReason('Chưa có lệnh.') });
  });
});

describe('buildJudgePrompt', () => {
  const base: JudgeInput = {
    text: 'Viết API đăng nhập',
    acceptance: 'Có test cho đăng nhập',
    agent: 'worker',
    role: 'dev',
    readOnly: false,
    result: 'exit 0',
    conflicts: [],
    evidenceAsked: false,
  };

  it('requires code evidence for an item that edits code', () => {
    expect(buildJudgePrompt(base)).toContain('The result must show evidence');
  });

  it('judges a read-only item on its report alone', () => {
    const prompt = buildJudgePrompt({ ...base, readOnly: true });
    expect(prompt).toContain('Judge the report alone; no code evidence is needed.');
    expect(prompt).not.toContain('The result must show evidence');
  });

  it('names open conflicts and forbids a pass while one is open', () => {
    const prompt = buildJudgePrompt({ ...base, conflicts: ['#3', 'checkout chính'] });
    expect(prompt).toContain('Open conflicts: #3, checkout chính.');
    expect(prompt).toContain('Do not answer pass while a conflict is open.');
  });

  it('says the worker was already asked for evidence once', () => {
    expect(buildJudgePrompt({ ...base, evidenceAsked: true })).toContain(
      'already asked for that evidence once',
    );
  });

  it('wraps the item text as data between BEGIN and END markers', () => {
    expect(buildJudgePrompt(base)).toContain('BEGIN work item\nViết API đăng nhập\nEND work item');
  });

  it('clips a long result before it reaches the prompt', () => {
    const result = 'r'.repeat(JUDGE_RESULT_MAX_CHARS + 500);
    expect(buildJudgePrompt({ ...base, result })).not.toContain(
      'r'.repeat(JUDGE_RESULT_MAX_CHARS + 1),
    );
  });

  it('states when the worker captured no result', () => {
    expect(buildJudgePrompt({ ...base, result: undefined })).toContain('(no result captured)');
  });
});
