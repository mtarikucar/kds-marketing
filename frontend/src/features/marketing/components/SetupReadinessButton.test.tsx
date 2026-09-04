import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SetupReadinessButton } from './SetupReadinessButton';

vi.mock('../api/marketingApi', () => ({ default: { get: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> | string) => {
      const base = typeof o === 'string' ? o : ((o?.defaultValue as string) ?? k);
      const vars = typeof o === 'string' ? {} : (o ?? {});
      return base.replace(/\{\{(\w+)\}\}/g, (_m, n) => String((vars as any)[n] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

const api = (await import('../api/marketingApi')).default as unknown as { get: ReturnType<typeof vi.fn> };

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'products',
  group: 'selling',
  state: 'MISSING',
  to: '/products',
  mcpTool: 'jeeta.create_product',
  ...over,
});

function payload(items: unknown[]) {
  const list = items as { state: string }[];
  return {
    items,
    total: list.length,
    ready: list.filter((i) => i.state === 'READY').length,
    attention: list.filter((i) => i.state === 'ATTENTION').length,
  };
}

async function wrap(items: unknown[]) {
  api.get.mockResolvedValue({ data: payload(items) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SetupReadinessButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * WHAT THE ENGINE IS STILL MISSING, in the chrome.
 *
 * The first-run guide is finished once and dismissed. This asks a standing
 * question whose answer changes on its own — a token expires, a wallet empties,
 * a campaign is paused — and nothing else in the product says so when a
 * capability quietly turns off.
 */
describe('SetupReadinessButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing rather than taking the header down with it', async () => {
    // It sits in the app chrome. A throw here does not degrade one panel, it
    // removes navigation, search and the profile menu — and the shapes that
    // reach it are not hypothetical: an older backend mid-rolling-deploy, a
    // proxy's HTML error page, a 204 with no body.
    for (const body of [undefined, null, {}, { items: null }, '<html>502</html>']) {
      api.get.mockResolvedValue({ data: body });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { container, unmount } = render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <SetupReadinessButton />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('counts the gaps on the badge', async () => {
    await wrap([item(), item({ id: 'strategy', state: 'READY' }), item({ id: 'sms' })]);
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('shows no badge at all when everything is in place', async () => {
    // A permanent number beside the bell is a number people stop seeing, and
    // this one has to still mean something on the day an account breaks.
    await wrap([item({ state: 'READY' }), item({ id: 'sms', state: 'READY' })]);
    expect(await screen.findByRole('button', { name: 'Setup readiness' })).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('says the system under-performs until the rest are done', async () => {
    // The whole point of surfacing this: an engine missing its inputs does not
    // fail, it quietly does less — the failure nobody reports.
    const user = userEvent.setup();
    await wrap([item(), item({ id: 'sms', state: 'READY' })]);
    await user.click(await screen.findByRole('button', { name: 'Setup readiness' }));
    expect(
      await screen.findByText(/1 of 2 in place.*reduced strength or not at all/i),
    ).toBeInTheDocument();
  });

  it('says so plainly when nothing is left', async () => {
    const user = userEvent.setup();
    await wrap([item({ state: 'READY' })]);
    await user.click(await screen.findByRole('button', { name: 'Setup readiness' }));
    expect(await screen.findByText(/running at full strength/i)).toBeInTheDocument();
  });

  it('marks the gaps the connected Claude can close, and only those', async () => {
    // Without this the panel is a list of complaints. With it, the work can be
    // handed over — and the ones it must not touch are marked by their absence
    // rather than left to anyone's judgement.
    const user = userEvent.setup();
    await wrap([
      item({ id: 'products', mcpTool: 'jeeta.create_product' }),
      item({ id: 'payment-provider', group: 'selling', mcpTool: null }),
    ]);
    await user.click(await screen.findByRole('button', { name: 'Setup readiness' }));

    const marks = await screen.findAllByLabelText('Your connected Claude can do this');
    expect(marks).toHaveLength(1);
  });

  it('does not mark a READY item, however fixable it would have been', async () => {
    const user = userEvent.setup();
    await wrap([item({ state: 'READY', mcpTool: 'jeeta.create_product' })]);
    await user.click(await screen.findByRole('button', { name: 'Setup readiness' }));
    expect(screen.queryByLabelText('Your connected Claude can do this')).not.toBeInTheDocument();
  });

  it('takes you to the page that fixes it', async () => {
    const user = userEvent.setup();
    await wrap([item({ id: 'growth-wallet', group: 'fuel', to: '/billing', mcpTool: null })]);
    await user.click(await screen.findByRole('button', { name: 'Setup readiness' }));
    expect(screen.getByRole('link', { name: /growth-wallet/i })).toHaveAttribute('href', '/billing');
  });

  it('groups the list, so it reads as a sequence rather than a pile', async () => {
    const user = userEvent.setup();
    await wrap([
      item({ id: 'brand-profile', group: 'identity' }),
      item({ id: 'growth-wallet', group: 'fuel' }),
      item({ id: 'strategy', group: 'plan' }),
    ]);
    await user.click(await screen.findByRole('button', { name: 'Setup readiness' }));
    // Identity before plan before fuel — you cannot sensibly arm a machine
    // whose inputs are missing, and the order says so.
    const headings = screen.getAllByText(/^(identity|plan|fuel)$/).map((e) => e.textContent);
    expect(headings).toEqual(['identity', 'plan', 'fuel']);
  });
});
