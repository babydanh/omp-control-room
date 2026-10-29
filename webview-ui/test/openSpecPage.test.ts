import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OpenSpecPage } from '../src/company/components/OpenSpecPage.js';

describe('OpenSpecPage', () => {
  it('does not claim there are no changes when the listing request failed', () => {
    const markup = renderToStaticMarkup(
      createElement(OpenSpecPage, {
        changes: null,
        loading: false,
        error: 'Không thể đọc OpenSpec.',
        file: null,
        onRefresh: () => {},
        onOpenFile: () => {},
        onCloseFile: () => {},
      }),
    );

    expect(markup).toContain('Không thể đọc OpenSpec.');
    expect(markup).not.toContain('Không tìm thấy OpenSpec changes');
  });
});
