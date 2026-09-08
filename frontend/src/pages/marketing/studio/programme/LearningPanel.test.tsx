import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LearningPanel } from './LearningPanel';
import { historyKeys, polylinePoints } from './WeightHistory';
import type { LearningView, TypeView } from '../../../../features/marketing/api/contentProgramme.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const type = (key: string, name: string): TypeView => ({
  id: `t-${key}`,
  key,
  name,
  description: '',
  active: true,
  minShare: 0.05,
  maxShare: 0.4,
  defaultDurationSec: 15,
  networks: [],
  weight: 0,
  samples: 0,
  meanReward: null,
  plannedShare: 0,
});

const learning: LearningView = {
  phase: 'LEARN',
  lastReweightedAt: '2026-09-07T03:00:00.000Z',
  networks: ['INSTAGRAM', 'TIKTOK'],
  rows: [
    { typeKey: 'howto', network: 'ALL', samples: 6, alpha: 4.2, beta: 2.8, meanReward: 0.6, weight: 0.4, computedAt: '2026-09-07T03:00:00.000Z' },
    { typeKey: 'bts', network: 'ALL', samples: 5, alpha: 2.5, beta: 3.5, meanReward: 0.42, weight: 0.28, computedAt: '2026-09-07T03:00:00.000Z' },
    { typeKey: 'howto', network: 'TIKTOK', samples: 3, alpha: 2.1, beta: 1.9, meanReward: 0.53, weight: 0.35, computedAt: '2026-09-07T03:00:00.000Z' },
  ],
  history: [
    { computedAt: '2026-08-24T03:00:00.000Z', weights: { howto: 0.33, bts: 0.33 } },
    { computedAt: '2026-08-31T03:00:00.000Z', weights: { howto: 0.36, bts: 0.31 } },
    { computedAt: '2026-09-07T03:00:00.000Z', weights: { howto: 0.4, bts: 0.28 } },
  ],
};

describe('LearningPanel', () => {
  it('renders the phase, the last reweight and the type × network table', () => {
    render(<LearningPanel learning={learning} types={[type('howto', 'Nasıl yapılır'), type('bts', 'Kamera arkası')]} />);

    expect(screen.getByText('Öğreniyor')).toBeInTheDocument();
    expect(screen.getByTestId('programme-last-reweighted')).toHaveTextContent('Son yeniden ağırlıklandırma:');

    const rows = screen.getAllByTestId('programme-learning-row');
    expect(rows).toHaveLength(3);
    // Pooled rows first, then per network; within a network, heaviest first.
    expect(rows[0]).toHaveTextContent('Nasıl yapılır');
    expect(rows[0]).toHaveTextContent('Tümü');
    expect(rows[0]).toHaveTextContent('0.60');
    expect(rows[0]).toHaveTextContent('0.40');
    expect(rows[1]).toHaveTextContent('Kamera arkası');
    expect(rows[2]).toHaveTextContent('TIKTOK');
  });

  it('draws one polyline per type and the same numbers in an accessible table', () => {
    render(<LearningPanel learning={learning} types={[type('howto', 'Nasıl yapılır'), type('bts', 'Kamera arkası')]} />);

    const lines = screen.getAllByTestId('programme-weight-line');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveAttribute('data-type', 'howto');
    expect(lines[0].getAttribute('points')!.split(' ')).toHaveLength(3);

    const table = screen.getByTestId('programme-weight-table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Tarih', 'Nasıl yapılır', 'Kamera arkası']);
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(3);
    expect(body[2]).toHaveTextContent('0.40');
    expect(body[2]).toHaveTextContent('0.28');
    // The chart is described by the table, not by nothing.
    expect(screen.getByRole('img')).toHaveAttribute('aria-describedby', table.id);
  });

  it('says so when there is no history yet, instead of drawing an empty chart', () => {
    render(<LearningPanel learning={{ ...learning, history: [], rows: [] }} types={[]} />);
    expect(screen.getByTestId('programme-weight-history-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('programme-weight-history')).not.toBeInTheDocument();
    expect(screen.getByText('Ölçülmüş slot yok; ilk yayınlar olgunlaşınca tablo dolar.')).toBeInTheDocument();
  });
});

describe('WeightHistory geometry', () => {
  it('keys follow first appearance, and a higher weight is a smaller y', () => {
    expect(historyKeys(learning.history)).toEqual(['howto', 'bts']);
    const pts = polylinePoints(learning.history, 'howto').split(' ').map((p) => p.split(',').map(Number));
    // x strictly increases with reweight index; y falls as the weight rises.
    expect(pts[0][0]).toBeLessThan(pts[1][0]);
    expect(pts[1][0]).toBeLessThan(pts[2][0]);
    expect(pts[2][1]).toBeLessThan(pts[0][1]);
  });

  it('clamps an out-of-range weight to the chart', () => {
    const pts = polylinePoints([{ computedAt: 'x', weights: { a: 7 } }, { computedAt: 'y', weights: { a: -2 } }], 'a')
      .split(' ')
      .map((p) => Number(p.split(',')[1]));
    expect(pts[0]).toBeLessThan(pts[1]);
    expect(pts[0]).toBeGreaterThanOrEqual(0);
  });
});
