import { describe, expect, it } from 'vitest';

import { imageFiles, withImagePath, withoutImagePath } from '../src/company/promptImages.js';

describe('promptImages', () => {
  it('appends an image path to the draft with one space around it', () => {
    expect(withImagePath('', 'C:\\a\\x.png')).toBe('C:\\a\\x.png ');
    expect(withImagePath('xem ảnh này', 'C:\\a\\x.png')).toBe('xem ảnh này C:\\a\\x.png ');
    expect(withImagePath('dòng 1\n', 'C:\\a\\x.png')).toBe('dòng 1\nC:\\a\\x.png ');
  });

  it('takes an image path back out of the draft, leaving the other text and images', () => {
    const draft = withImagePath(withImagePath('xem ', 'C:\\a\\x.png'), 'C:\\a\\y.png');
    expect(withoutImagePath(draft, 'C:\\a\\x.png')).toBe('xem C:\\a\\y.png ');
    expect(withoutImagePath('sửa C:\\a\\x.png', 'C:\\a\\x.png')).toBe('sửa ');
  });

  it('keeps only the images among pasted or dropped files', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(imageFiles([png, text])).toEqual([png]);
  });
});
