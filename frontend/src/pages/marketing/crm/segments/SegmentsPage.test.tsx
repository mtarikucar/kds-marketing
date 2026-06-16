import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SegmentsPage from './SegmentsPage';
import { normalizeRoot } from './segmentSerialize';
import { buildFieldChoices, comparatorsFor, countNodes } from '../segmentDsl';

vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SegmentsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<SegmentsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the builder dialog and validates an empty name', async () => {
    render(<SegmentsPage />, { wrapper });
    const newBtn = screen.getAllByRole('button', { name: /new segment/i })[0];
    await userEvent.click(newBtn);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    const candidates = screen.getAllByRole('button', { name: /new segment|save/i });
    const saveBtn = candidates[candidates.length - 1];
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});

describe('segment DSL helpers', () => {
  it('wraps a bare leaf into a root AND group', () => {
    const root = normalizeRoot({ field: 'status', cmp: 'eq', value: 'WON' });
    expect(root.op).toBe('and');
    expect(root.children).toHaveLength(1);
  });

  it('passes a group definition through, defaulting to AND', () => {
    const root = normalizeRoot({ op: 'or', children: [{ field: 'city', cmp: 'eq', value: 'X' }] });
    expect(root.op).toBe('or');
    expect(root.children).toHaveLength(1);
  });

  it('falls back to an empty group for malformed input', () => {
    expect(normalizeRoot(null).children).toHaveLength(0);
  });

  it('exposes native fields, the tag field, and cf: choices from defs', () => {
    const choices = buildFieldChoices([
      {
        id: '1', workspaceId: 'w', entity: 'LEAD', key: 'loyalty', label: 'Loyalty',
        type: 'SELECT', options: [{ value: 'gold', label: 'Gold' }], required: false,
        position: 0, archived: false, createdAt: '', updatedAt: '',
      },
    ]);
    expect(choices.some((c) => c.value === 'status' && c.group === 'lead')).toBe(true);
    expect(choices.some((c) => c.value === 'tag' && c.group === 'tag')).toBe(true);
    const cf = choices.find((c) => c.value === 'cf:loyalty');
    expect(cf?.group).toBe('custom');
    expect(cf?.options).toHaveLength(1);
  });

  it('maps comparator sets to field kind (tag → has/hasNot)', () => {
    const tag = { value: 'tag', label: 'Tag', group: 'tag' as const, dataType: 'string' as const };
    expect(comparatorsFor(tag)).toEqual(['has', 'hasNot']);
  });

  it('counts nodes across nested groups', () => {
    const tree = {
      op: 'and' as const,
      children: [
        { field: 'status', cmp: 'eq', value: 'WON' },
        { op: 'or' as const, children: [{ field: 'city', cmp: 'eq', value: 'X' }] },
      ],
    };
    // root + leaf + group + leaf = 4
    expect(countNodes(tree)).toBe(4);
  });
});
