import { describe, expect, it } from 'vitest';

import { scrollFadeEdges } from '../src/company/scrollFades.js';

describe('scrollFadeEdges', () => {
  it('fades nothing when the content fits the area', () => {
    expect(scrollFadeEdges({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toEqual({
      top: false,
      bottom: false,
    });
  });

  it('ignores a sub-pixel overflow from rounding', () => {
    expect(scrollFadeEdges({ scrollTop: 0, scrollHeight: 301, clientHeight: 300 })).toEqual({
      top: false,
      bottom: false,
    });
  });

  it('fades only the bottom edge while the area sits at its top', () => {
    expect(scrollFadeEdges({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 })).toEqual({
      top: false,
      bottom: true,
    });
  });

  it('fades both edges while content lies beyond each', () => {
    expect(scrollFadeEdges({ scrollTop: 300, scrollHeight: 900, clientHeight: 300 })).toEqual({
      top: true,
      bottom: true,
    });
  });

  it('fades only the top edge once the area is scrolled to its end', () => {
    expect(scrollFadeEdges({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 })).toEqual({
      top: true,
      bottom: false,
    });
  });

  it('treats a position within a pixel of an edge as on that edge', () => {
    expect(scrollFadeEdges({ scrollTop: 0.5, scrollHeight: 900, clientHeight: 300 })).toEqual({
      top: false,
      bottom: true,
    });
    expect(scrollFadeEdges({ scrollTop: 599.5, scrollHeight: 900, clientHeight: 300 })).toEqual({
      top: true,
      bottom: false,
    });
  });
});
