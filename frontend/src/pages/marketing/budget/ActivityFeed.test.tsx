import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityFeed } from './ActivityFeed';
import type { ActivityItem } from '../../../features/marketing/api/growthBudget.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));

const items: ActivityItem[] = [
  {
    ts: '2026-07-05T10:00:00.000Z',
    type: 'RUN',
    data: {
      id: 'r1',
      kind: 'REALLOCATION',
      autonomy: 'AUTO',
      ok: true,
      createdAt: '2026-07-05T10:00:00.000Z',
      before: [{ channel: 'META', campaignRef: '', budget: 100 }],
      after: [{ channel: 'META', campaignRef: '', budget: 150, deltaPct: 50, reason: 'strong marginal ROAS' }],
      objective: { channels: [{ channel: 'META', avgRoas: 3 }] },
    },
  },
  {
    ts: '2026-07-05T09:00:00.000Z',
    type: 'SPEND',
    data: { id: 's1', channel: 'SMS', reason: 'SMS', delta: '-25', balanceAfter: '975', ref: null, createdAt: '2026-07-05T09:00:00.000Z' },
  },
  {
    ts: '2026-07-05T08:00:00.000Z',
    type: 'WALLET',
    data: { id: 'w1', kind: 'TOPUP', delta: '500', balanceAfter: '1500', ref: 'order:o1', note: null, createdAt: '2026-07-05T08:00:00.000Z' },
  },
];

describe('ActivityFeed', () => {
  it('renders a RUN reallocation with before→after per channel + the reason', () => {
    render(<ActivityFeed items={[items[0]]} currency="TRY" />);
    expect(screen.getByText('Autopilot rebalanced the budget')).toBeInTheDocument();
    expect(screen.getByText('Meta')).toBeInTheDocument();
    // before → after amounts (formatted; just assert the numbers surface)
    expect(screen.getByText(/100/)).toBeInTheDocument();
    expect(screen.getByText(/150/)).toBeInTheDocument();
    expect(screen.getByText(/strong marginal ROAS/)).toBeInTheDocument();
  });

  it('renders a SPEND entry with channel + amount', () => {
    render(<ActivityFeed items={[items[1]]} currency="TRY" />);
    expect(screen.getByText('Engine spend')).toBeInTheDocument();
    expect(screen.getByText('SMS')).toBeInTheDocument();
    expect(screen.getByText(/25/)).toBeInTheDocument();
  });

  it('renders a WALLET top-up in plain language', () => {
    render(<ActivityFeed items={[items[2]]} currency="TRY" />);
    expect(screen.getByText('Credit loaded')).toBeInTheDocument();
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it('shows an empty state when there is nothing yet', () => {
    render(<ActivityFeed items={[]} currency="TRY" />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });
});
