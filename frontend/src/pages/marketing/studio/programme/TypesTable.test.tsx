import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypesTable } from './TypesTable';
import * as api from '../../../../features/marketing/api/contentProgramme.service';
import type { TypeView } from '../../../../features/marketing/api/contentProgramme.service';

vi.mock('../../../../features/marketing/api/contentProgramme.service', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return { ...actual, updateType: vi.fn(), createType: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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

const updateType = vi.mocked(api.updateType);
const createType = vi.mocked(api.createType);

const type = (over: Partial<TypeView> = {}): TypeView => ({
  id: 't1',
  key: 'howto',
  name: 'Nasıl yapılır',
  description: '',
  active: true,
  minShare: 0.05,
  maxShare: 0.4,
  defaultDurationSec: 15,
  networks: ['INSTAGRAM'],
  weight: 0.4,
  samples: 6,
  meanReward: 0.6,
  plannedShare: 0.5,
  ...over,
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  updateType.mockImplementation(async (_id, typeId, patch) => type({ id: typeId, ...patch }));
  createType.mockResolvedValue(type({ id: 't9', key: 'ugc', name: 'UGC' }));
});

describe('TypesTable', () => {
  it('renders every type with samples, mean reward and both shares', () => {
    wrap(<TypesTable programmeId="p1" types={[type(), type({ id: 't2', key: 'bts', name: 'Kamera arkası', meanReward: null, samples: 0 })]} />);
    const rows = screen.getAllByTestId('programme-type-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Nasıl yapılır');
    expect(rows[0]).toHaveTextContent('howto · 15s · INSTAGRAM');
    expect(rows[0]).toHaveTextContent('0.60');
    expect(rows[1]).toHaveTextContent('—');
  });

  it('reads both shares to a screen reader as text, while the bars stay hidden', () => {
    wrap(<TypesTable programmeId="p1" types={[type({ plannedShare: 0.5, weight: 0.4 })]} />);
    const text = screen.getByTestId('programme-share-text');
    expect(text).toHaveTextContent('Planlanan 50%, Öğrenilen 40%');
    expect(text).not.toHaveAttribute('aria-hidden');
    expect(text.className).toMatch(/sr-only/);
  });

  it('saves a changed floor on blur, and only the floor', async () => {
    const user = userEvent.setup();
    wrap(<TypesTable programmeId="p1" types={[type()]} />);
    const floor = screen.getByLabelText('Nasıl yapılır taban payı');
    await user.clear(floor);
    await user.type(floor, '0.1');
    await user.tab();
    await waitFor(() => expect(updateType).toHaveBeenCalledWith('p1', 't1', { minShare: 0.1 }));
    expect(updateType).toHaveBeenCalledTimes(1);
  });

  it('does not save an unchanged share on blur', async () => {
    const user = userEvent.setup();
    wrap(<TypesTable programmeId="p1" types={[type()]} />);
    await user.click(screen.getByLabelText('Nasıl yapılır tavan payı'));
    await user.tab();
    expect(updateType).not.toHaveBeenCalled();
  });

  it('the active switch toggles the type', async () => {
    const user = userEvent.setup();
    wrap(<TypesTable programmeId="p1" types={[type()]} />);
    await user.click(screen.getByRole('switch', { name: 'Nasıl yapılır aktif' }));
    await waitFor(() => expect(updateType).toHaveBeenCalledWith('p1', 't1', { active: false }));
  });

  it('adds a type through the small dialog', async () => {
    const user = userEvent.setup();
    wrap(<TypesTable programmeId="p1" types={[type()]} />);
    await user.click(screen.getByRole('button', { name: 'Tür ekle' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Anahtar (slug)'), 'ugc');
    await user.type(within(dialog).getByLabelText('Tür'), 'UGC');
    await user.type(within(dialog).getByLabelText('Açıklama'), 'Müşteri çekimi');
    const dur = within(dialog).getByLabelText('Süre (saniye)');
    await user.clear(dur);
    await user.type(dur, '20');
    await user.click(within(dialog).getByRole('button', { name: 'Tür ekle' }));
    await waitFor(() =>
      expect(createType).toHaveBeenCalledWith('p1', { key: 'ugc', name: 'UGC', description: 'Müşteri çekimi', defaultDurationSec: 20 }),
    );
  });
});
