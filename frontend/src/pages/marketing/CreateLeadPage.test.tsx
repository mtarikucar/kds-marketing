import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Stub i18n — t echoes the key so we can match on i18n keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string }) => {
      const k = Array.isArray(key) ? key[0] : key;
      return opts?.defaultValue ?? k;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Stub the API — we only care the mutation is called, not the response.
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: { id: 'new-123' } })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (select: (state: unknown) => unknown) => select({ user: { workspaceId: 'w1' } }),
}));

// Stub sonner so toasts don't complain in jsdom.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import CreateLeadPage from './CreateLeadPage';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCreate() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={['/leads/new']}>
        <Routes>
          <Route path="/leads/new" element={<CreateLeadPage />} />
          <Route path="/leads/:id" element={<div>Lead Detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CreateLeadPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { default: api } = await import('../../features/marketing/api/marketingApi');
    vi.mocked(api.get).mockImplementation(() => Promise.resolve({ data: [] }));
  });

  it('mounts in create mode and shows the page header title', () => {
    renderCreate();
    expect(screen.getByText('createLead.titleNew')).toBeInTheDocument();
  });

  it('does not ask generic leads for restaurant-specific fields', () => {
    renderCreate();
    for (const field of ['tableCount', 'branchCount', 'currentSystem']) {
      expect(screen.queryByLabelText(new RegExp(`createLead.fields.${field}`))).not.toBeInTheDocument();
    }
  });

  it('uses the workspace business type when creating a generic lead', async () => {
    const { default: api } = await import('../../features/marketing/api/marketingApi');
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve({ data:
      url.includes('/business-types') ? { businessTypes: ['CONSULTING'] } : [] }));
    const user = userEvent.setup();
    renderCreate();
    await waitFor(() => expect(screen.getByLabelText(/createLead.fields.businessType/i)).toHaveTextContent('CONSULTING'));
    await user.type(screen.getByLabelText(/createLead.fields.businessName/i), 'Acme');
    await user.type(screen.getByLabelText(/createLead.fields.contactPerson/i), 'Ada');
    await user.click(screen.getByRole('button', { name: /createLead.submitCreate/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leads', expect.objectContaining({ businessType: 'CONSULTING' })));
  });

  it('keeps a historical business type that is no longer offered by the workspace', async () => {
    const { default: api } = await import('../../features/marketing/api/marketingApi');
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve({ data:
      url.includes('/business-types') ? { businessTypes: ['CONSULTING'] } :
      url === '/leads/5' ? { id: '5', businessName: 'Acme', contactPerson: 'Ada', businessType: 'LEGACY_TYPE', tableCount: 12, currentSystem: 'POS' } : [] }));
    const user = userEvent.setup();
    render(<QueryClientProvider client={makeClient()}><MemoryRouter initialEntries={['/leads/5/edit']}><Routes>
      <Route path="/leads/:id/edit" element={<CreateLeadPage />} />
      <Route path="/leads/:id" element={<div>Detail</div>} />
    </Routes></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByLabelText(/createLead.fields.businessType/i)).toHaveTextContent('LEGACY TYPE'));
    await user.click(screen.getByLabelText(/createLead.fields.businessType/i));
    await user.click(screen.getByRole('option', { name: 'CONSULTING' }));
    await user.click(screen.getByLabelText(/createLead.fields.businessType/i));
    await user.click(screen.getByRole('option', { name: 'LEGACY TYPE' }));
    await user.click(screen.getByRole('button', { name: /createLead.submitUpdate/i }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/leads/5', expect.objectContaining({ businessType: 'LEGACY_TYPE' })));
    expect(vi.mocked(api.patch).mock.calls[0][1]).not.toHaveProperty('currentSystem');
  });

  it('fires zod validation and shows an error when required fields are empty on submit', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.click(screen.getByRole('button', { name: /createLead.submitCreate/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
  });

  it('calls the create mutation when the form is submitted with valid data', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderCreate();

    // Fill required text fields by label
    await user.type(
      screen.getByLabelText(/createLead.fields.businessName/i),
      'Acme Restaurant',
    );
    await user.type(
      screen.getByLabelText(/createLead.fields.contactPerson/i),
      'Jane Doe',
    );

    await user.click(screen.getByRole('button', { name: /createLead.submitCreate/i }));

    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/leads',
        expect.objectContaining({ businessName: 'Acme Restaurant', contactPerson: 'Jane Doe' }),
      );
    });
  });

  it('renders a cancel button that navigates back', () => {
    renderCreate();
    expect(screen.getByRole('button', { name: /common.cancel/i })).toBeInTheDocument();
  });

  // Both /leads/:id/edit and /leads/new render the SAME CreateLeadPage element,
  // so React reuses the instance (no remount) when navigating between them. The
  // edit form must not carry a previously-edited lead's values onto the fresh
  // new-lead form (it would create a duplicate contact pre-filled with another
  // lead's data). Mirrors the reused-component stale-state fixes elsewhere.
  it('clears the form when navigating from edit to the new-lead form (reused instance)', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    vi.mocked(marketingApi.get).mockImplementation((url: string) =>
      Promise.resolve({
        data: url.includes('/custom-fields')
          ? []
          : url.includes('/leads/5')
            ? { id: '5', businessName: 'Acme Corp', contactPerson: 'Jane' }
            : {},
      }),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={['/leads/5/edit']}>
          <Link to="/leads/new">go-new</Link>
          <Routes>
            <Route path="/leads/new" element={<CreateLeadPage />} />
            <Route path="/leads/:id/edit" element={<CreateLeadPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const nameInput = (await screen.findByLabelText(
      /createLead.fields.businessName/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('Acme Corp'));

    await user.click(screen.getByText('go-new'));

    await waitFor(() => {
      const ni = screen.getByLabelText(/createLead.fields.businessName/i) as HTMLInputElement;
      expect(ni.value).toBe('');
    });
  });

  it('renders workspace custom fields and includes them in the create payload', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    // Serve a required custom field def from /custom-fields; everything else {}.
    vi.mocked(marketingApi.get).mockImplementation((url: string) =>
      Promise.resolve({ data: url.includes('/custom-fields')
        ? [{ id: 'cf1', key: 'priority_tier', label: 'Priority tier', type: 'TEXT', required: true, archived: false, options: [] }]
        : {} }),
    );
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByLabelText(/createLead.fields.businessName/i), 'Acme');
    await user.type(screen.getByLabelText(/createLead.fields.contactPerson/i), 'Jane');
    // The custom field renders as an input labeled by its def — without it a
    // required custom field would make the lead un-creatable.
    await user.type(await screen.findByLabelText(/Priority tier/i), 'Gold');

    await user.click(screen.getByRole('button', { name: /createLead.submitCreate/i }));

    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/leads',
        expect.objectContaining({ customFields: { priority_tier: 'Gold' } }),
      );
    });
  });
});
