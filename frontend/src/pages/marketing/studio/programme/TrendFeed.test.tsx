import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TrendFeed, safeHref } from './TrendFeed';
import type { TrendView } from '../../../../features/marketing/api/contentProgramme.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string) => d ?? '',
    i18n: { language: 'tr' },
  }),
}));

const trend = (over: Partial<TrendView> = {}): TrendView => ({
  id: 'tr1',
  network: 'TIKTOK',
  kind: 'SOUND',
  title: 'Rüzgar sesi',
  ref: 'https://example.test/s',
  decayed: 0.8,
  relevance: 0.4,
  suggestion: 0.46,
  observedAt: '2026-09-08T07:00:00.000Z',
  ...over,
});

describe('safeHref', () => {
  it('keeps http and https only', () => {
    expect(safeHref('https://example.test/a')).toBe('https://example.test/a');
    expect(safeHref('http://example.test/a')).toBe('http://example.test/a');
  });

  it('refuses javascript:, data:, relative paths and bare ids', () => {
    // eslint-disable-next-line no-script-url
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('abc123')).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});

describe('TrendFeed links', () => {
  it('renders an http(s) ref as a link and anything else as text', () => {
    render(
      <TrendFeed
        trends={[
          trend(),
          // eslint-disable-next-line no-script-url
          trend({ id: 'tr2', title: 'Kötü', ref: 'javascript:alert(1)', suggestion: 0.3 }),
          trend({ id: 'tr3', title: 'Çıplak', ref: 'abc123', suggestion: 0.2 }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId('programme-trend-row');
    expect(within(rows[0]).getByRole('link', { name: /Rüzgar sesi/ })).toHaveAttribute('href', 'https://example.test/s');
    expect(within(rows[1]).queryByRole('link')).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Kötü');
    expect(within(rows[2]).queryByRole('link')).not.toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Çıplak');
  });
});
