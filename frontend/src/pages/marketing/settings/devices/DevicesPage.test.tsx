import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// `vi.hoisted`, because `vi.mock`'s factory is lifted above every const in the
// file — a plain `const api` here is still in its temporal dead zone when the
// factory runs.
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../../features/marketing/api/marketingApi', () => ({ default: api }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

import DevicesPage from './DevicesPage';

const device = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  label: 'Office phone',
  platform: 'ANDROID',
  mode: 'MANUAL',
  status: 'ACTIVE',
  lastSeenAt: new Date().toISOString(),
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DevicesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Route-aware stub: the device list and one phone's command history are two
 *  different GETs, and a single blanket mock would feed the list into both. */
const respond = (devices: unknown[], commands: unknown[] = []) =>
  api.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url.includes('/commands') ? commands : devices }),
  );

describe('DevicesPage', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockClear();
    api.post.mockResolvedValue({ data: {} });
  });

  it('says a phone has to be added here before the desktop app can use it', async () => {
    respond([]);
    renderPage();
    expect(await screen.findByText('No phone paired')).toBeInTheDocument();
    expect(screen.getByText(/produces the id the desktop app asks for/i)).toBeInTheDocument();
  });

  it('shows the device id, because that is the thing the desktop app asks for', async () => {
    respond([device()]);
    renderPage();
    expect(await screen.findByText('dev-1')).toBeInTheDocument();
  });

  it('distinguishes a phone that is offline from one that is merely idle', async () => {
    // Ten minutes of silence. The queue behaves identically either way, so the
    // badge is the only thing that tells an operator which problem they have.
    respond([device({ lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() })]);
    renderPage();
    expect(await screen.findByText('Bridge offline')).toBeInTheDocument();
  });

  it('asks before letting a phone act without a human, and only then saves it', async () => {
    const user = userEvent.setup();
    respond([device()]);
    renderPage();
    await screen.findByText('Office phone');

    await user.click(screen.getByRole('switch'));

    // The click alone must not have changed anything on the server.
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText(/Nobody at the phone is asked first/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/devices/dev-1/mode', { mode: 'AUTO' }),
    );
  });

  it('turns the asking back ON without a confirmation — the safe direction is one click', async () => {
    const user = userEvent.setup();
    respond([device({ mode: 'AUTO' })]);
    renderPage();
    await screen.findByText('Office phone');

    await user.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/devices/dev-1/mode', { mode: 'MANUAL' }),
    );
  });

  it('warns that pausing DROPS the queue rather than holding it', async () => {
    const user = userEvent.setup();
    respond([device()]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Pause/ }));

    expect(await screen.findByText(/dropped, not held/i)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Pause' }).at(-1)!);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/devices/dev-1/status', { status: 'PAUSED' }),
    );
  });

  it('adds a phone by name and leaves the serial to the desktop app', async () => {
    const user = userEvent.setup();
    respond([]);
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: /Add phone/ }))[0]);
    await user.type(screen.getByLabelText('Name'), 'Shelf phone');
    await user.click(screen.getAllByRole('button', { name: 'Add phone' }).at(-1)!);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/devices', { label: 'Shelf phone', serial: undefined }),
    );
  });

  it('reads a phone command history only when the section is opened', async () => {
    const user = userEvent.setup();
    respond([device()], [
      { id: 'c1', kind: 'OPEN_URL', status: 'REFUSED', createdAt: new Date().toISOString() },
    ]);
    renderPage();
    await screen.findByText('Office phone');
    expect(api.get.mock.calls.some(([u]) => String(u).includes('/commands'))).toBe(false);

    await user.click(screen.getByText('Recent commands'));
    expect(await screen.findByText('OPEN_URL')).toBeInTheDocument();
    // A refusal is a person saying no. It must read as an outcome, not a fault.
    expect(screen.getByText('REFUSED')).toBeInTheDocument();
  });
});
