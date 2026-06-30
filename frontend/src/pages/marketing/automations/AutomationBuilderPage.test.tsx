import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AutomationBuilderPage from './AutomationBuilderPage';

const { WORKFLOW } = vi.hoisted(() => ({
  WORKFLOW: {
    id: 'wf-1', name: 'Welcome flow', status: 'ACTIVE', version: 1,
    trigger: { type: 'lead.created', filters: [] },
    steps: [{ type: 'send_sms', body: 'hi' }],
    goal: null,
  },
}));

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/workflows/wf-1') return Promise.resolve({ data: WORKFLOW });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn().mockResolvedValue({ data: WORKFLOW }),
    patch: vi.fn().mockResolvedValue({ data: WORKFLOW }),
  },
}));

// The React Flow canvas needs a real layout engine; stub it for the page test.
vi.mock('./WorkflowCanvas', () => ({
  WorkflowCanvas: ({ triggerType }: { triggerType: string }) => <div data-testid="canvas">{triggerType}</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: unknown) => (typeof d === 'string' ? d : Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/automations/new" element={<AutomationBuilderPage />} />
          <Route path="/automations/:id/edit" element={<AutomationBuilderPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AutomationBuilderPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads an existing workflow into the builder (edit mode)', async () => {
    renderAt('/automations/wf-1/edit');
    await waitFor(() => {
      expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Welcome flow');
    });
    expect(screen.getByTestId('canvas').textContent).toBe('lead.created');
  });

  it('mounts an empty builder (new mode)', () => {
    renderAt('/automations/new');
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('');
  });
});
