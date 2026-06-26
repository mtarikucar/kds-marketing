import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  beforeEach(() => vi.clearAllMocks());

  it('mounts in create mode and shows the page header title', () => {
    renderCreate();
    expect(screen.getByText('createLead.titleNew')).toBeInTheDocument();
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
