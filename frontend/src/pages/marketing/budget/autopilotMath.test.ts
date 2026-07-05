import { describe, it, expect } from 'vitest';
import { deriveGrowthMultiple, pickLatestObjective, money, num } from './autopilotMath';
import type { ActivityItem } from '../../../features/marketing/api/growthBudget.service';

describe('num', () => {
  it('parses decimal strings and passes numbers through', () => {
    expect(num('123.45')).toBeCloseTo(123.45);
    expect(num(7)).toBe(7);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('garbage')).toBe(0);
  });
});

describe('money', () => {
  it('formats in the given currency, not hard-coded TRY', () => {
    // i18next is uninitialized in tests → falls back to 'en'.
    expect(money(1234, 'USD')).toContain('$');
  });

  it('survives an unknown currency code', () => {
    expect(money(50, 'NOPE!')).toContain('50');
  });
});

describe('deriveGrowthMultiple', () => {
  const allocations = [
    { channel: 'META', spentAmount: '1000' },
    { channel: 'CONTENT', spentAmount: '500' },
  ];

  it('derives attributed revenue = Σ(channel spend × avgRoas) and multiple = revenue ÷ spend', () => {
    const objective = {
      channels: [
        { channel: 'META', avgRoas: 3, marginalRoas: 2 },
        { channel: 'CONTENT', avgRoas: 0, marginalRoas: 0 },
      ],
    };
    const r = deriveGrowthMultiple(allocations, objective);
    expect(r.spend).toBe(1500);
    expect(r.revenue).toBe(3000);
    expect(r.multiple).toBeCloseTo(2);
  });

  it('returns a null multiple when there is no revenue signal yet', () => {
    const r = deriveGrowthMultiple(allocations, null);
    expect(r.spend).toBe(1500);
    expect(r.revenue).toBeNull();
    expect(r.multiple).toBeNull();
  });

  it('returns a null multiple when nothing has been spent', () => {
    const r = deriveGrowthMultiple(
      [{ channel: 'META', spentAmount: '0' }],
      { channels: [{ channel: 'META', avgRoas: 3 }] },
    );
    expect(r.multiple).toBeNull();
  });
});

describe('pickLatestObjective', () => {
  it('returns the objective of the newest RUN item that carries channel signal', () => {
    const items: ActivityItem[] = [
      { ts: '2026-07-05T10:00:00Z', type: 'WALLET', data: { kind: 'TOPUP', delta: '500' } },
      { ts: '2026-07-05T09:00:00Z', type: 'RUN', data: { kind: 'REALLOCATION', objective: null } },
      {
        ts: '2026-07-05T08:00:00Z',
        type: 'RUN',
        data: { kind: 'REALLOCATION', objective: { channels: [{ channel: 'META', avgRoas: 2.5 }] } },
      },
    ];
    expect(pickLatestObjective(items)?.channels?.[0]).toMatchObject({ channel: 'META', avgRoas: 2.5 });
  });

  it('returns null when no RUN carries an objective', () => {
    expect(pickLatestObjective([])).toBeNull();
    expect(pickLatestObjective([{ ts: '', type: 'SPEND', data: {} }])).toBeNull();
  });
});
