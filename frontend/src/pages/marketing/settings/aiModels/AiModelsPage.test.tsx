import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      const isStr = typeof def === 'string';
      const template = isStr
        ? (def as string)
        : ((def as { defaultValue?: string } | undefined)?.defaultValue ?? key);
      const vars = (isStr ? opts : (def as Record<string, unknown> | undefined)) ?? {};
      return String(template).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../../../features/marketing/api/mediaModels.service', () => ({
  getMediaModelDefaults: vi.fn(),
  setMediaModelDefaults: vi.fn(),
}));

import {
  getMediaModelDefaults,
  setMediaModelDefaults,
} from '../../../../features/marketing/api/mediaModels.service';
import AiModelsPage from './AiModelsPage';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(async (url: string) => {
    if (url === '/ai/execution-policy') return { data: { jobs: [], mcp: { connected: false }, local: { configured: false, models: {} } } };
    if (url === '/mcp-console/overview') return { data: { canToggle: true } };
    throw new Error('unavailable');
  }) },
}));

const CATALOGUE = [
  { id: 'fal-ai/qwen-image', type: 'IMAGE' as const, label: 'Draft image', priceUsd: 0.02, credits: 2, isPlatformDefault: false },
  { id: 'fal-ai/seedream', type: 'IMAGE' as const, label: 'Final image', priceUsd: 0.03, credits: 3, isPlatformDefault: true },
  { id: 'fal-ai/seedance-lite', type: 'VIDEO' as const, label: 'Short video', pricePerSecUsd: 0.025, creditsPerSec: 3, isPlatformDefault: true },
  { id: 'fal-ai/veo3.1/fast', type: 'VIDEO' as const, label: 'Video + audio', pricePerSecUsd: 0.15, creditsPerSec: 15, isPlatformDefault: false },
];

function payload(over: Partial<Record<string, unknown>> = {}) {
  return {
    defaultImageModel: null,
    defaultVideoModel: null,
    effectiveImageModel: 'fal-ai/seedream',
    effectiveVideoModel: 'fal-ai/seedance-lite',
    retiredImageModel: null,
    retiredVideoModel: null,
    models: CATALOGUE,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={qc}>
        <AiModelsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...view, qc };
}

beforeEach(() => {
  useMarketingAuthStore.setState({ user: {
    id: 'manager', workspaceId: 'workspace', role: 'MANAGER',
    email: 'manager@example.com', firstName: 'Test', lastName: 'Manager',
  } });
  vi.mocked(getMediaModelDefaults).mockReset();
  vi.mocked(setMediaModelDefaults).mockReset();
});

/**
 * Every query is scoped to ONE card's radiogroup. Both cards legitimately offer
 * a "Platform default" row and both can quote the same number, so an unscoped
 * getByRole would be ambiguous — and, worse, a scoped-looking assertion that
 * accidentally matched the other card would pass while the video card rendered
 * nothing at all.
 */
function card(name: string) {
  return within(screen.getByRole('radiogroup', { name }));
}

/**
 * The label of the ONE option carrying the "In use" badge in a card, or null.
 *
 * Returns the label rather than a boolean so a badge on the WRONG row fails
 * with the row it landed on — "some element says In use" would pass on exactly
 * the screen this is meant to catch. Exactly one badge, or the card is claiming
 * two models are running.
 */
function badgedInUse(name: string): string | null {
  const badges = card(name).queryAllByText('In use');
  expect(badges.length).toBeLessThanOrEqual(1);
  if (!badges[0]) return null;
  // The badge sits beside the option's <Label id="…-label"> in one flex row.
  const label = badges[0].closest('div')?.querySelector('[id$="-label"]');
  return label?.textContent ?? null;
}

async function openCatalogue(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Choose ${name.toLowerCase()}` }));
  await screen.findByRole('dialog', { name });
}

describe('AiModelsPage', () => {
  it('shows the flat per-run tariff for a video model instead of an unknown per-second rate', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload({ models: [...CATALOGUE,
      { id: 'flat-video', type: 'VIDEO', label: 'Flat video', priceUsd: .4, credits: 40, isPlatformDefault: false },
    ] }) as never);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Choose video model' }));
    expect(screen.getByRole('radio', { name: /Flat video 40 credits \/ run \(\$0.4\)/ })).toBeVisible();
  });
  it('keeps catalogues in a keyboard-accessible sheet and preserves a choice when reopening', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload() as never);
    renderPage();
    const trigger = await screen.findByRole('button', { name: 'Choose video model' });
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(card('Video model').getByRole('radio', { name: /Video \+ audio/ }));
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Media models' })).toHaveTextContent('Video + audio');
    await openCatalogue('Video model');
    expect(card('Video model').getByRole('radio', { name: /Video \+ audio/ })).toBeChecked();
  });

  it('keeps a media draft after failure and clears it on workspace changes', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload() as never);
    vi.mocked(setMediaModelDefaults).mockRejectedValue(new Error('offline'));
    const { qc } = renderPage();
    await openCatalogue('Video model');
    await userEvent.click(card('Video model').getByRole('radio', { name: /Video \+ audio/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/model defaults could not be saved/i)).toBeInTheDocument();
    await openCatalogue('Video model');
    expect(card('Video model').getByRole('radio', { name: /Video \+ audio/ })).toBeChecked();
    await userEvent.keyboard('{Escape}');
    await act(async () => useMarketingAuthStore.getState().updateUser({ workspaceId: 'other' }));
    await openCatalogue('Video model');
    expect(card('Video model').getByRole('radio', { name: /Platform default/ })).toBeChecked();
    expect(qc.getQueryData(['marketing', 'workspace', 'media-models', 'other', 'manager'])).toBeDefined();
  });

  /**
   * The whole reason this screen exists rather than a dropdown of ids: video is
   * the most expensive action in the product and the catalogue spans a 10x
   * range, so the price has to be ON the option a manager is choosing between.
   */
  it('prices every option, in the unit its kind is billed in', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload() as never);
    renderPage();

    await openCatalogue('Video model');

    // The price is part of the radio's ACCESSIBLE NAME, not merely somewhere on
    // the page — so this cannot pass with the number rendered next to the wrong
    // option, or rendered outside the control a manager is choosing with.
    const video = card('Video model');
    expect(video.getByRole('radio', { name: /Video \+ audio.*15 credits\/sec \(\$0\.15\/sec\)/ })).toBeInTheDocument();
    expect(video.getByRole('radio', { name: /^Short video .*3 credits\/sec \(\$0\.025\/sec\)/ })).toBeInTheDocument();

    // Images bill FLAT, per image — a different unit, said differently.
    await userEvent.keyboard('{Escape}');
    await openCatalogue('Image model');
    const image = card('Image model');
    expect(image.getByRole('radio', { name: /Draft image.*2 credits \/ image \(\$0\.02\)/ })).toBeInTheDocument();
    expect(image.getByRole('radio', { name: /^Final image .*3 credits \/ image \(\$0\.03\)/ })).toBeInTheDocument();
  });

  /**
   * "No choice" is a real, selectable state — not an empty picker. It is what
   * keeps a workspace following the platform's constant when that constant
   * moves, so it must be reachable BACK to, not only away from.
   */
  it('offers the platform default as an option and selects it when nothing is stored', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload() as never);
    renderPage();

    await openCatalogue('Video model');
    // It NAMES what it currently is. "Platform default" on its own would be the
    // one blind option on the screen that exists to stop the choice being blind.
    const videoDefault = card('Video model').getByRole('radio', {
      name: /Platform default \(Short video\)/,
    });
    expect(videoDefault).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a stored choice as the selected option', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(
      payload({ defaultVideoModel: 'fal-ai/veo3.1/fast', effectiveVideoModel: 'fal-ai/veo3.1/fast' }) as never,
    );
    renderPage();

    await openCatalogue('Video model');
    const chosen = card('Video model').getByRole('radio', { name: /Video \+ audio/ });
    expect(chosen).toHaveAttribute('aria-checked', 'true');
    // And the platform row is no longer the selected one.
    expect(
      card('Video model').getByRole('radio', { name: /Platform default/ }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  /**
   * Only what changed is sent. `absent` and `null` mean different things to the
   * PATCH — absent leaves the other half alone — so saving a video choice must
   * not also transmit the image field and quietly re-assert it.
   */
  it('patches only the field the manager changed', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload() as never);
    vi.mocked(setMediaModelDefaults).mockResolvedValue(
      payload({ defaultVideoModel: 'fal-ai/veo3.1/fast' }) as never,
    );
    renderPage();

    await openCatalogue('Video model');
    await userEvent.click(card('Video model').getByRole('radio', { name: /Video \+ audio/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setMediaModelDefaults).toHaveBeenCalledTimes(1));
    expect(setMediaModelDefaults).toHaveBeenCalledWith({ defaultVideoModel: 'fal-ai/veo3.1/fast' });
  });

  it('clears a choice back to the platform default with an explicit null', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(
      payload({ defaultVideoModel: 'fal-ai/veo3.1/fast', effectiveVideoModel: 'fal-ai/veo3.1/fast' }) as never,
    );
    vi.mocked(setMediaModelDefaults).mockResolvedValue(payload() as never);
    renderPage();

    await openCatalogue('Video model');
    await userEvent.click(card('Video model').getByRole('radio', { name: /Platform default/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setMediaModelDefaults).toHaveBeenCalledTimes(1));
    expect(setMediaModelDefaults).toHaveBeenCalledWith({ defaultVideoModel: null });
  });

  it('leaves Save inert until something actually changed', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(payload() as never);
    renderPage();
    await openCatalogue('Video model');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  /**
   * Error is not empty. A failed load must not render as "there are no models to
   * choose from" — that reads as a product with one hardcoded model, which is
   * the opposite of what this screen says.
   */
  it('says the catalogue could not be loaded, rather than showing none', async () => {
    vi.mocked(getMediaModelDefaults).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(
      await screen.findByText(/could not be loaded/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  /**
   * The retired-choice state, which is the one this card used to render as a
   * blank.
   *
   * A model can leave the catalogue (it is a TypeScript constant, so a deploy
   * does it) while a workspace's stored choice still names it. Generation is
   * already correct — `MediaGenService` ignores the stored id and runs the
   * platform constant — so the ONLY thing at stake here is whether the screen
   * admits it. Before the fix it did not: the server echoed the retired id back
   * as `effectiveVideoModel`, so the RadioGroup's value matched no option, no
   * row was badged "In use", and the one screen whose purpose is to price the
   * decision said nothing about what the next clip would cost.
   */
  it('says what actually runs when the stored choice has left the catalogue', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(
      payload({
        defaultVideoModel: 'fal-ai/kling-v1-retired',
        // The server applies the fallback; `effective*` is always catalogued.
        effectiveVideoModel: 'fal-ai/seedance-lite',
        retiredVideoModel: 'fal-ai/kling-v1-retired',
      }) as never,
    );
    renderPage();

    await openCatalogue('Video model');

    // Names the choice that no longer exists...
    expect(await screen.findByText(/fal-ai\/kling-v1-retired/)).toBeInTheDocument();
    // ...says what runs instead, WITH its price, which is the decision at stake.
    expect(screen.getByText(/Short video runs instead \(3 credits\/sec \(\$0\.025\/sec\)\)/)).toBeInTheDocument();
    // ...and the badge is back on a real row, so the card is not silently blank.
    // Asserted ON the row rather than anywhere on the page: an "In use" badge
    // rendered beside the wrong model is the same lie in a different place.
    expect(badgedInUse('Video model')).toBe('Short video');
  });

  /** The warning is not permanent furniture: an ordinary workspace must not be
   *  told something is wrong with its configuration. */
  it('says nothing of the sort when the stored choice is fine', async () => {
    vi.mocked(getMediaModelDefaults).mockResolvedValue(
      payload({
        defaultVideoModel: 'fal-ai/veo3.1/fast',
        effectiveVideoModel: 'fal-ai/veo3.1/fast',
      }) as never,
    );
    renderPage();
    await openCatalogue('Video model');
    expect(screen.queryByText(/no longer in the catalogue/i)).not.toBeInTheDocument();
    expect(badgedInUse('Video model')).toBe('Video + audio');
  });
});
