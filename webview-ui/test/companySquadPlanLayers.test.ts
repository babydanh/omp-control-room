import { describe, expect, it } from 'vitest';

import {
  squadLayerHead,
  squadLayers,
  squadRowDepths,
  waitReasonText,
} from '../src/company/squadPlanLayers.js';

describe('squadRowDepths', () => {
  it('puts a row that waits for nothing in layer 0, and one layer below each row it waits for', () => {
    expect(
      squadRowDepths([
        { dependsOn: [] },
        { dependsOn: [{ kind: 'row', row: 0 }] },
        {
          dependsOn: [
            { kind: 'row', row: 0 },
            { kind: 'row', row: 1 },
          ],
        },
      ]),
    ).toEqual([0, 1, 2]);
  });

  it('counts only row waits, so an item wait does not move a row down', () => {
    expect(squadRowDepths([{ dependsOn: [{ kind: 'item', sequence: 4 }] }])).toEqual([0]);
  });

  it('ignores references outside the proposal, to the row itself, and back into a cycle', () => {
    expect(
      squadRowDepths([
        { dependsOn: [{ kind: 'row', row: 1 }] },
        { dependsOn: [{ kind: 'row', row: 0 }] },
        {
          dependsOn: [
            { kind: 'row', row: 2 },
            { kind: 'row', row: 9 },
          ],
        },
        { dependsOn: [{ kind: 'row', row: 2 }] },
      ]),
    ).toEqual([1, 0, 0, 1]);
  });
});

describe('squadLayers', () => {
  it('groups rows by depth, shallowest first, keeping proposal order inside a layer', () => {
    expect(
      squadLayers([
        { dependsOn: [] },
        { dependsOn: [{ kind: 'row', row: 0 }] },
        { dependsOn: [] },
        { dependsOn: [{ kind: 'row', row: 2 }] },
      ]),
    ).toEqual([
      { depth: 0, rows: [0, 2] },
      { depth: 1, rows: [1, 3] },
    ]);
  });

  it('is empty for a plan with no rows', () => {
    expect(squadLayers([])).toEqual([]);
  });
});

describe('squadLayerHead', () => {
  it('numbers layers from 1 and says whether the first layer runs one row or several at once', () => {
    expect(squadLayerHead({ depth: 0, rows: [0] })).toEqual({
      title: 'Bước 1',
      hint: 'Chạy ngay',
    });
    expect(squadLayerHead({ depth: 0, rows: [0, 2] })).toEqual({
      title: 'Bước 1',
      hint: 'Chạy song song',
    });
  });

  it('says a deeper layer waits for the step before it', () => {
    expect(squadLayerHead({ depth: 2, rows: [4] })).toEqual({
      title: 'Bước 3',
      hint: 'Chờ bước trước xong',
    });
  });
});

describe('waitReasonText', () => {
  it('is null for a row that waits for nothing', () => {
    expect(waitReasonText([])).toBeNull();
  });

  it('names a row wait by its 1-based row number and an item wait by #n', () => {
    expect(
      waitReasonText([
        { kind: 'row', row: 0 },
        { kind: 'row', row: 2 },
        { kind: 'item', sequence: 5 },
      ]),
    ).toBe('Chờ dòng 1, dòng 3, #5');
  });

  it('marks a wait it cannot name with a question mark', () => {
    expect(waitReasonText([{ kind: 'row' }, { kind: 'item' }])).toBe('Chờ dòng ?, #?');
  });
});
