// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DevelopmentCardView } from '../src/client/components/DevelopmentCardView.js';
import '../src/client/i18n.js';
import { requireCard } from '../src/shared/data/gameData.js';

describe('reserved card preview presentation', () => {
  it('uses the shared development-card representation without action UI', () => {
    const card = requireCard('L1-001');
    const html = renderToStaticMarkup(
      <DevelopmentCardView card={card} variant="preview" />,
    );

    expect(html).toContain('development-card development-card-preview');
    expect(html).toContain(card.id);
    expect(html).toContain(`>${card.points} <`);
    expect(html).toContain('card-bonus');
    expect(html).toContain('card-cost');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('card-mode-label');
    expect(html).not.toContain('card-unavailable');
  });
});
