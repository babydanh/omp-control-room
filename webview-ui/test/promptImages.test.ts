import { describe, expect, it } from 'vitest';

import { imageFiles, withImagePath } from '../src/company/promptImages.js';

describe('promptImages', () => {
  it('appends an image path to the draft with one space around it', () => {
    expect(withImagePath('', 'C:\\a\\x.png')).toBe('C:\\a\\x.png ');
    expect(withImagePath('xem ảnh này', 'C:\\a\\x.png')).toBe('xem ảnh này C:\\a\\x.png ');
    expect(withImagePath('dòng 1\n', 'C:\\a\\x.png')).toBe('dòng 1\nC:\\a\\x.png ');
  });

  it('keeps only the images among pasted or dropped files', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(imageFiles([png, text])).toEqual([png]);
  });
});
