import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import PipelineSettingsPage from './PipelineSettingsPage';
import {
  listPipelines,
  deletePipeline,
  updatePipeline,
} from '../../../features/marketing/api/opportunities.service';

vi.mock('../../../features/marketing/api/opportunities.service', () => ({
  listPipelines: vi.fn(),
  createPipeline: vi.fn(),
  updatePipeline: vi.fn().mockResolvedValue({}),
  deletePipeline: vi.fn().mockResolvedValue({ message: 'ok' }),
  addStage: vi.fn(),
  updateStage: vi.fn(),
  deleteStage: vi.fn(),
  reorderStages: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const mockList = listPipelines as unknown as ReturnType<typeof vi.fn>;
const mockDelete = deletePipeline as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = updatePipeline as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('PipelineSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([
      { id: 'p2', name: 'Enterprise', isDefault: false, position: 1, archived: false, stages: [] },
    ]);
  });

  it('confirms before deleting a pipeline (no immediate delete on the trash click)', async () => {
    render(<PipelineSettingsPage />, { wrapper });
    await screen.findByText('Enterprise');

    // Deleting a pipeline cascade-removes its deals — it must not fire on a
    // single icon click; a confirmation dialog gates it.
    await userEvent.click(screen.getByRole('button', { name: /delete pipeline/i }));
    expect(mockDelete).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('p2'));
  });

  it('archives a pipeline (soft-retire that preserves WON/LOST deal history)', async () => {
    render(<PipelineSettingsPage />, { wrapper });
    await screen.findByText('Enterprise');

    await userEvent.click(screen.getByRole('button', { name: /archive/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('p2', { archived: true }));
  });

  // Each pipeline's Archive button is a per-row action — the shared archive
  // mutation's isPending must be scoped by `variables === p.id`, or archiving one
  // pipeline freezes EVERY pipeline's archive button (per-row loading bleed).
  it('archiving one pipeline does not disable the other pipelines’ archive buttons', async () => {
    mockList.mockResolvedValue([
      { id: 'p2', name: 'Enterprise', isDefault: false, position: 1, archived: false, stages: [] },
      { id: 'p3', name: 'SMB', isDefault: false, position: 2, archived: false, stages: [] },
    ]);
    mockUpdate.mockImplementation(() => new Promise(() => {})); // archive stays in-flight
    const user = userEvent.setup();
    render(<PipelineSettingsPage />, { wrapper });
    await screen.findByText('SMB');

    await user.click(screen.getAllByRole('button', { name: /archive/i })[0]); // archive Enterprise

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /archive/i })[0]).toBeDisabled(),
    );
    // The OTHER pipeline's archive button must stay enabled.
    expect(screen.getAllByRole('button', { name: /archive/i })[1]).not.toBeDisabled();
  });
});
