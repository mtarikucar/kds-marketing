import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stub i18n — t echoes the key so we can match on i18n keys.
// The second positional arg is a string default, not an options object, so we
// return the key (matching how other page tests work in this codebase).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], _opts?: unknown) => {
      return Array.isArray(key) ? key[0] : key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Stub marketingApi
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    post: vi.fn(() =>
      Promise.resolve({
        data: {
          user: { id: '1', email: 'a@b.com', firstName: 'A', lastName: 'B', role: 'OWNER', workspaceId: 'ws1' },
          accessToken: 'at',
          refreshToken: 'rt',
        },
      }),
    ),
  },
}));

// Stub the auth store.
vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({
    login: vi.fn(),
    setMemberships: vi.fn(),
    isAuthenticated: false,
  }),
}));

// Stub membership hydration (register mirrors login's best-effort fetch).
vi.mock('../../features/marketing/api/membershipApi', () => ({
  fetchMemberships: vi.fn(() => Promise.resolve([])),
}));

import RegisterWorkspacePage from './RegisterWorkspacePage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path="/register" element={<RegisterWorkspacePage />} />
        <Route path="/dashboard" element={<div>Dashboard</div>} />
        <Route path="/login" element={<div>Login</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RegisterWorkspacePage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and shows register title + submit button', () => {
    renderPage();
    // t returns keys when stubbed — match on i18n key
    expect(screen.getByText('register.title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register.submit/i })).toBeInTheDocument();
  });

  it('shows validation errors when submitting empty form', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /register.submit/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
  });

  it('calls marketingApi.post /auth/register-workspace on valid submit', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderPage();

    // Labels come from i18n keys when stubbed
    await user.type(screen.getByLabelText(/register.workspaceName/i), 'Acme Inc.');
    await user.type(screen.getByLabelText(/register.productName/i), 'Acme POS');
    await user.type(screen.getByLabelText(/register.firstName/i), 'Jane');
    await user.type(screen.getByLabelText(/register.lastName/i), 'Doe');
    await user.type(screen.getByLabelText(/login.emailLabel/i), 'jane@acme.com');
    await user.type(screen.getByLabelText(/login.passwordLabel/i), 'Secure1Password');

    await user.click(screen.getByRole('button', { name: /register.submit/i }));

    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/auth/register-workspace',
        expect.objectContaining({
          workspaceName: 'Acme Inc.',
          productName: 'Acme POS',
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@acme.com',
        }),
      );
    });
  });

  /**
   * The signup POST is the ONLY moment the platform ever learns what zone a
   * self-serve workspace operates in.
   *
   * `Workspace.timezone` shipped with a 'UTC' default and no writer a customer
   * could reach, so every workspace held 'UTC' while five consumers read the
   * column as an answer — a Turkish workspace's "today" ran 03:00→03:00 and
   * dropped its own early-morning rows out of every list. Drop this field from
   * the payload and the platform goes back to guessing, silently, for every new
   * customer; nothing else on this page or after it asks the question.
   */
  it('sends the browser timezone so a new workspace is not born on UTC by default', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const resolved = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'Europe/Istanbul' } as Intl.ResolvedDateTimeFormatOptions);
    try {
      const user = userEvent.setup();
      renderPage();
      await fillRequired(user);
      await user.click(screen.getByRole('button', { name: /register.submit/i }));

      await waitFor(() => {
        expect(marketingApi.post).toHaveBeenCalledWith(
          '/auth/register-workspace',
          expect.objectContaining({ timezone: 'Europe/Istanbul' }),
        );
      });
    } finally {
      resolved.mockRestore();
    }
  });

  it('still signs up when the browser will not name a zone', async () => {
    // A hint, not a form field: an Intl that throws (or reports nothing) must
    // cost the signup nothing — the backend falls back to the schema default,
    // leaving the workspace exactly where every pre-existing one already is.
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const resolved = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(() => {
        throw new Error('no ICU data');
      });
    try {
      const user = userEvent.setup();
      renderPage();
      await fillRequired(user);
      await user.click(screen.getByRole('button', { name: /register.submit/i }));

      await waitFor(() => expect(marketingApi.post).toHaveBeenCalled());
      expect(
        (marketingApi.post as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1],
      ).toMatchObject({ timezone: undefined });
    } finally {
      resolved.mockRestore();
    }
  });

  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/register.workspaceName/i), 'Acme Inc.');
    await user.type(screen.getByLabelText(/register.productName/i), 'Acme POS');
    await user.type(screen.getByLabelText(/register.firstName/i), 'Jane');
    await user.type(screen.getByLabelText(/register.lastName/i), 'Doe');
    await user.type(screen.getByLabelText(/login.emailLabel/i), 'jane@acme.com');
    await user.type(screen.getByLabelText(/login.passwordLabel/i), 'Secure1Password');
  }

  it('allows an empty productUrl (optional)', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    // productUrl left blank
    await user.click(screen.getByRole('button', { name: /register.submit/i }));
    await waitFor(() => expect(marketingApi.post).toHaveBeenCalled());
  });

  it('rejects a malformed productUrl client-side (no POST)', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/register.productUrl/i), 'not a url');
    await user.click(screen.getByRole('button', { name: /register.submit/i }));
    await waitFor(() =>
      expect(screen.getByText('validation.invalidUrl')).toBeInTheDocument(),
    );
    expect(marketingApi.post).not.toHaveBeenCalled();
  });

  it('accepts a valid productUrl', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/register.productUrl/i), 'https://acme.com');
    await user.click(screen.getByRole('button', { name: /register.submit/i }));
    await waitFor(() =>
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/auth/register-workspace',
        expect.objectContaining({ productUrl: 'https://acme.com' }),
      ),
    );
  });

  it('sends productDescription when provided', async () => {
    const { default: marketingApi } = await import('../../features/marketing/api/marketingApi');
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.type(
      screen.getByLabelText(/register.productDescription/i),
      'We run a cloud POS for cafes.',
    );
    await user.click(screen.getByRole('button', { name: /register.submit/i }));
    await waitFor(() =>
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/auth/register-workspace',
        expect.objectContaining({ productDescription: 'We run a cloud POS for cafes.' }),
      ),
    );
  });

  it('shows a login link', () => {
    renderPage();
    expect(screen.getByRole('link', { name: /login.submit/i })).toBeInTheDocument();
  });
});
