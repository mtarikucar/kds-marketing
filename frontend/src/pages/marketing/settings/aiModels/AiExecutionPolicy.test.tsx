import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import marketingApi from "@/features/marketing/api/marketingApi";
import { useMarketingAuthStore } from "@/store/marketingAuthStore";
import en from "@/i18n/locales/en/marketing.json";
import tr from "@/i18n/locales/tr/marketing.json";
import AiModelsPage from "./AiModelsPage";
import { usageDashboardFixture } from "./usageDashboard.fixture";

vi.mock("@/features/marketing/api/marketingApi", () => ({
  default: { get: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const policy = () => ({
  jobs: [
    {
      id: "future.action",
      label: "Future action",
      category: "New category",
      description: "An action added by the server.",
      enabled: true,
      provider: "MCP",
      providers: ["API", "MCP", "LOCAL"],
      availability: { API: true, MCP: false, LOCAL: false },
    },
    {
      id: "voice.transcribe",
      label: "Transcribe calls",
      category: "Voice",
      description: "Turn calls into text.",
      enabled: false,
      provider: "LOCAL",
      providers: ["API", "LOCAL"],
      availability: { API: true, MCP: false, LOCAL: true },
    },
    {
      id: "media.image",
      label: "Generate image",
      category: "Media",
      description: "Create an image.",
      enabled: true,
      provider: "API",
      providers: ["API"],
      availability: { API: true, MCP: false, LOCAL: false },
    },
  ],
  local: {
    configured: true,
    models: { classify: "qwen-small", transcribe: "whisper" },
  },
  mcp: { connected: false },
});

const media = {
  defaultImageModel: null,
  defaultVideoModel: null,
  effectiveImageModel: "image",
  effectiveVideoModel: "video",
  retiredImageModel: null,
  retiredVideoModel: null,
  models: [
    {
      id: "image",
      type: "IMAGE",
      label: "Image model A",
      priceUsd: 0.02,
      credits: 2,
      isPlatformDefault: true,
    },
    {
      id: "video",
      type: "VIDEO",
      label: "Video model A",
      pricePerSecUsd: 0.025,
      creditsPerSec: 3,
      isPlatformDefault: true,
    },
  ],
};

let readUsage: () => Promise<{ data: ReturnType<typeof usageDashboardFixture> }>;

let readPolicy: () => Promise<{ data: ReturnType<typeof policy> }>;
let readPermissions: () => Promise<{ data: { canToggle: boolean } }>;

beforeEach(() => {
  vi.resetAllMocks();
  useMarketingAuthStore.setState({
    user: {
      id: "owner",
      workspaceId: "workspace",
      role: "OWNER",
      email: "owner@example.com",
      firstName: "Test",
      lastName: "Owner",
    },
  });
  readUsage = async () => ({ data: usageDashboardFixture() });
  readPolicy = async () => ({ data: policy() });
  readPermissions = async () => ({ data: { canToggle: true } });
  vi.mocked(marketingApi.get).mockImplementation(async (url) => {
    if (url === "/ai/usage-dashboard") return readUsage();
    if (url === "/ai/execution-policy") return readPolicy();
    if (url === "/mcp-console/overview") return readPermissions();
    if (url === "/workspaces/media-models") return { data: media };
    throw new Error(`Unexpected GET ${url}`);
  });
});

async function renderPage(language = "en") {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: "en",
    resources: { en: { marketing: en }, tr: { marketing: tr } },
    interpolation: { escapeValue: false },
  });
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <QueryClientProvider client={qc}>
          <AiModelsPage />
        </QueryClientProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
  return qc;
}

async function actions() {
  return within(await screen.findByRole("region", { name: "AI actions" }));
}

async function choose(label: string, provider: RegExp) {
  await userEvent.click(
    screen.getByRole("combobox", { name: `${label}: provider` }),
  );
  await userEvent.click(await screen.findByRole("option", { name: provider }));
}

describe("AI execution policy on the AI models page", () => {
  it("renders server-defined actions and per-action providers while preserving media selectors", async () => {
    await renderPage();
    const card = await actions();
    expect(
      await card.findByRole("switch", { name: "Future action: active" }),
    ).toBeChecked();
    expect(card.queryByText("An action added by the server.")).not.toBeInTheDocument();
    await userEvent.click(card.getByRole("button", { name: "Future action: details" }));
    expect(screen.getByRole("dialog", { name: "Future action" })).toHaveTextContent("An action added by the server.");
    await userEvent.keyboard("{Escape}");
    expect(card.getByRole("row", { name: /Future action/ })).toHaveTextContent("New category");
    expect(card.getAllByRole("switch")).toHaveLength(3);
    expect(
      card.getByRole("combobox", { name: "Future action: provider" }),
    ).toHaveTextContent(/MCP.*Not ready/);
    expect(
      card.getByRole("combobox", { name: "Transcribe calls: provider" }),
    ).toHaveTextContent("Local");
    await userEvent.click(
      card.getByRole("combobox", { name: "Generate image: provider" }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "API" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: "Choose video model" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose image model" }),
    ).toBeInTheDocument();
  });

  it("can explicitly choose the displayed inherited provider and remove its old fallback rule", async () => {
    const inherited = policy();
    Object.assign(inherited.jobs[0], { explicit: false });
    readPolicy = async () => ({ data: inherited });
    vi.mocked(marketingApi.patch).mockResolvedValue({ data: policy() });
    await renderPage();
    const card = await actions();
    await card.findByRole("combobox", { name: "Future action: provider" });
    await choose("Future action", /^MCP.*Not ready/);
    await userEvent.click(card.getByRole("button", { name: "Save actions" }));
    await waitFor(() =>
      expect(marketingApi.patch).toHaveBeenCalledWith("/ai/execution-policy", {
        jobs: { "future.action": { provider: "MCP" } },
      }),
    );
  });

  it("saves only changed fields and jobs, including a selectable unconfigured provider", async () => {
    const fresh = policy();
    fresh.jobs[0].provider = "LOCAL";
    fresh.jobs[1].enabled = true;
    vi.mocked(marketingApi.patch).mockResolvedValue({ data: fresh });
    await renderPage();
    const card = await actions();
    const save = await card.findByRole("button", { name: "Save actions" });
    expect(save).toBeDisabled();
    await choose("Future action", /^Local.*Not ready/);
    await userEvent.click(
      card.getByRole("switch", { name: "Transcribe calls: active" }),
    );
    // A change reverted before saving must not be sent.
    await userEvent.click(
      card.getByRole("switch", { name: "Generate image: active" }),
    );
    await userEvent.click(
      card.getByRole("switch", { name: "Generate image: active" }),
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(marketingApi.patch).toHaveBeenCalledWith("/ai/execution-policy", {
        jobs: {
          "future.action": { provider: "LOCAL" },
          "voice.transcribe": { enabled: true },
        },
      }),
    );
    await waitFor(() => expect(save).toBeDisabled());
    expect(
      card.getByRole("combobox", { name: "Future action: provider" }),
    ).toHaveTextContent(/Local.*Not ready/);
    await waitFor(() =>
      expect(
        card.getByRole("switch", { name: "Transcribe calls: active" }),
      ).toBeChecked(),
    );
  });

  it("preserves drafts on a failed save and disables every action control while pending", async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(marketingApi.patch).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    await renderPage();
    const card = await actions();
    await card.findByRole("switch", { name: "Future action: active" });
    await choose("Future action", /^Local/);
    await userEvent.click(
      card.getByRole("switch", { name: "Future action: active" }),
    );
    await userEvent.click(card.getByRole("button", { name: "Save actions" }));
    await waitFor(() => expect(marketingApi.patch).toHaveBeenCalledTimes(1));
    for (const control of [
      ...card.getAllByRole("switch"),
      ...card.getAllByRole("combobox"),
    ])
      expect(control).toBeDisabled();
    expect(card.getByRole("button", { name: /Saving/ })).toBeDisabled();
    await act(async () => rejectSave(new Error("offline")));
    expect(await card.findByRole("alert")).toHaveTextContent(
      /could not be saved/i,
    );
    expect(
      card.getByRole("combobox", { name: "Future action: provider" }),
    ).toHaveTextContent(/Local.*Not ready/);
    expect(
      card.getByRole("switch", { name: "Future action: active" }),
    ).not.toBeChecked();
    const fresh = policy();
    fresh.jobs[0] = { ...fresh.jobs[0], enabled: false, provider: "LOCAL" };
    vi.mocked(marketingApi.patch).mockResolvedValueOnce({ data: fresh });
    await userEvent.click(card.getByRole("button", { name: "Save actions" }));
    await waitFor(() =>
      expect(marketingApi.patch).toHaveBeenLastCalledWith(
        "/ai/execution-policy",
        {
          jobs: { "future.action": { enabled: false, provider: "LOCAL" } },
        },
      ),
    );
    await waitFor(() =>
      expect(card.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("uses the fresh PATCH response as the saved state", async () => {
    const fresh = policy();
    fresh.jobs[0] = {
      ...fresh.jobs[0],
      enabled: false,
      provider: "LOCAL",
      availability: { API: true, MCP: false, LOCAL: true },
    };
    vi.mocked(marketingApi.patch).mockResolvedValue({ data: fresh });
    await renderPage();
    const card = await actions();
    await userEvent.click(
      await card.findByRole("switch", { name: "Future action: active" }),
    );
    await userEvent.click(card.getByRole("button", { name: "Save actions" }));
    await waitFor(() =>
      expect(
        card.getByRole("combobox", { name: "Future action: provider" }),
      ).toHaveTextContent(/^Local$/),
    );
    expect(card.getByRole("button", { name: "Save actions" })).toBeDisabled();
  });

  it("keeps action settings read-only for a manager even if the permission response allows toggling", async () => {
    useMarketingAuthStore.getState().updateUser({ role: "MANAGER" });
    await renderPage();
    const card = await actions();
    expect(
      await card.findByRole("switch", { name: "Future action: active" }),
    ).toBeDisabled();
    expect(card.getByText(/Only an owner/)).toBeInTheDocument();
    for (const control of card.getAllByRole("combobox", { name: /: provider$/ }))
      expect(control).toBeDisabled();
    expect(
      card.queryByRole("button", { name: "Save actions" }),
    ).not.toBeInTheDocument();
    expect(marketingApi.patch).not.toHaveBeenCalled();
  });

  it("keeps an owner without settings.manage read-only", async () => {
    readPermissions = async () => ({ data: { canToggle: false } });
    await renderPage();
    const card = await actions();
    expect(
      await card.findByRole("switch", { name: "Future action: active" }),
    ).toBeDisabled();
    expect(
      card.queryByRole("button", { name: "Save actions" }),
    ).not.toBeInTheDocument();
  });

  it("fails closed until owner permission is loaded and allows retrying permission errors", async () => {
    let rejectPermission!: (error: Error) => void;
    readPermissions = () =>
      new Promise((_resolve, reject) => {
        rejectPermission = reject;
      });
    await renderPage();
    const card = await actions();
    expect(
      await card.findByRole("switch", { name: "Future action: active" }),
    ).toBeDisabled();
    await act(async () => rejectPermission(new Error("offline")));
    expect(await card.findByRole("alert")).toHaveTextContent(/permissions/i);
    expect(
      card.getByRole("combobox", { name: "Future action: provider" }),
    ).toBeDisabled();
    readPermissions = async () => ({ data: { canToggle: true } });
    await userEvent.click(card.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        card.getByRole("switch", { name: "Future action: active" }),
      ).toBeEnabled(),
    );
  });

  it("shows a retryable policy load failure while the media selectors remain available", async () => {
    readPolicy = async () => {
      throw new Error("offline");
    };
    await renderPage();
    const card = await actions();
    expect(await card.findByRole("alert")).toHaveTextContent(
      /actions could not be loaded/i,
    );
    expect(card.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose video model" }),
    ).toBeInTheDocument();
    readPolicy = async () => ({ data: policy() });
    await userEvent.click(card.getByRole("button", { name: "Retry" }));
    expect(
      await card.findByRole("switch", { name: "Future action: active" }),
    ).toBeChecked();
  });

  it("does not invent rows when the server returns no actions", async () => {
    readPolicy = async () => ({ data: { ...policy(), jobs: [] } });
    readUsage = async () => ({ data: { ...usageDashboardFixture(), rows: [] } });
    await renderPage();
    const card = await actions();
    expect(
      await card.findByText("No AI actions available."),
    ).toBeInTheDocument();
    expect(card.queryByRole("switch")).not.toBeInTheDocument();
    expect(card.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains an unsaved provider during a background refresh", async () => {
    const qc = await renderPage();
    const card = await actions();
    await card.findByRole("switch", { name: "Future action: active" });
    await choose("Future action", /^Local/);
    const refreshed = policy();
    refreshed.jobs[1].enabled = true;
    readPolicy = async () => ({ data: refreshed });
    await act(async () => {
      await qc.refetchQueries({ type: "active" });
    });
    expect(
      card.getByRole("combobox", { name: "Future action: provider" }),
    ).toHaveTextContent(/Local/);
    await waitFor(() =>
      expect(
        card.getByRole("switch", { name: "Transcribe calls: active" }),
      ).toBeChecked(),
    );
    expect(card.getByRole("button", { name: "Save actions" })).toBeEnabled();
  });

  it.each([
    {
      language: "en",
      title: "AI actions",
      active: "Future action: active",
      provider: "Future action: provider",
      notReady: "Not ready",
      mcp: /own Claude.*connected agent.*quota.*cost/i,
      local: /vendor per-call.*hosting/i,
      waiting: /jobs wait.*no paid LLM fallback/i,
      mediaFees: /fal.*media.*separate.*fees.*Claude/i,
    },
    {
      language: "tr",
      title: "Yapay zeka işlemleri",
      active: "Future action: etkin",
      provider: "Future action: sağlayıcı",
      notReady: "Hazır değil",
      mcp: /kendi Claude.*bağlı.*kota.*ücret/i,
      local: /çağrı başına.*barındırma/i,
      waiting: /işleri bekler.*ücretli.*geçilmez/i,
      mediaFees: /fal.*medya.*ücret.*Claude/i,
    },
  ])(
    "localizes the controls and explains provider costs in $language",
    async ({
      language,
      title,
      active,
      provider,
      notReady,
      mcp,
      local,
      waiting,
      mediaFees,
    }) => {
      await renderPage(language);
      const card = within(await screen.findByRole("region", { name: title }));
      expect(
        await card.findByRole("switch", { name: active }),
      ).toBeInTheDocument();
      expect(card.getByRole("combobox", { name: provider })).toHaveTextContent(
        notReady,
      );
      await userEvent.click(card.getByText(language === "tr" ? "Sağlayıcılar ve ücretler" : "Providers and fees"));
      expect(card.getByText(mcp)).toBeInTheDocument();
      expect(card.getByText(local)).toBeInTheDocument();
      expect(card.getByText(waiting)).toBeInTheDocument();
      expect(card.getByText(mediaFees)).toBeInTheDocument();
    },
  );
});


describe("monthly usage beside policy controls", () => {
  it("shows measured usage, partial forecasts and read-only historical rows without hiding their costs", async () => {
    await renderPage();
    const overview = within(await screen.findByRole('region', { name: 'Monthly usage' }));
    expect(await overview.findByText('12,000')).toBeInTheDocument();
    expect(overview.getByText('$4.50')).toBeInTheDocument();
    expect(overview.getByText('36,000')).toBeInTheDocument();
    expect(overview.getByText('$13.50')).toBeInTheDocument();
    expect(overview.getByText('Partial estimate')).toBeInTheDocument();
    expect(overview.getByText(/10 observed days/)).toBeInTheDocument();
    expect(overview.getByText(/Europe\/Istanbul/)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'AI action usage and settings' });
    const row = within(table).getByRole('row', { name: /Future action/ });
    expect(row).toHaveTextContent('12,000');
    expect(row).toHaveTextContent('$3.50');
    const historical = within(table).getByRole('row', { name: /Legacy research/ });
    expect(historical).toHaveTextContent('$1.00');
    expect(within(historical).queryByRole('switch')).not.toBeInTheDocument();
    const local = within(table).getByRole('row', { name: /Transcribe calls/ });
    expect(local).not.toHaveTextContent('$0');
    expect(within(local).getAllByText('—').length).toBeGreaterThan(0);
    await userEvent.click(within(row).getByRole('button', { name: 'Future action: details' }));
    const detail = within(screen.getByRole('dialog', { name: 'Future action' }));
    expect(detail.getByText('Cache read')).toBeInTheDocument();
    expect(detail.getByText('4,000')).toBeInTheDocument();
    expect(detail.getByText('claude-test')).toBeInTheDocument();
    expect(detail.getByText(/Billing credits are separate/)).toBeInTheDocument();
  });

  it('filters rows without discarding edits, and keeps monthly totals unfiltered', async () => {
    await renderPage();
    const card = await actions();
    await card.findByRole('switch', { name: 'Future action: active' });
    await choose('Future action', /^Local/);
    const search = card.getByRole('searchbox', { name: 'Search actions' });
    await userEvent.type(search, 'legacy');
    expect(card.queryByRole('switch')).not.toBeInTheDocument();
    expect(card.getByRole('row', { name: /Legacy research/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Monthly usage' })).toHaveTextContent('12,000');
    await userEvent.clear(search);
    expect(card.getByRole('combobox', { name: 'Future action: provider' })).toHaveTextContent('Local');
    await userEvent.selectOptions(card.getByRole('combobox', { name: 'Category' }), 'Media');
    expect(card.getAllByRole('switch')).toHaveLength(1);
    expect(card.getByRole('button', { name: 'Save actions' })).toBeEnabled();
  });

  it('reports unavailable analytics after a failed refresh while keeping policy drafts usable', async () => {
    await renderPage();
    const card = await actions();
    await card.findByRole('switch', { name: 'Future action: active' });
    await choose('Future action', /^Local/);
    readUsage = async () => { throw new Error('offline'); };
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    const overview = screen.getByRole('region', { name: 'Monthly usage' });
    expect(await within(overview).findByRole('alert')).toHaveTextContent(/Usage is unavailable/);
    expect(within(overview).queryByText('$4.50')).not.toBeInTheDocument();
    expect(card.getByRole('row', { name: /Future action/ })).not.toHaveTextContent('$3.50');
    expect(card.getByRole('combobox', { name: 'Future action: provider' })).toHaveTextContent('Local');
    expect(card.getByRole('button', { name: 'Save actions' })).toBeEnabled();
    readUsage = async () => ({ data: usageDashboardFixture() });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    expect(await within(overview).findByText('$4.50')).toBeInTheDocument();
  });

  it.each(['INSUFFICIENT_HISTORY', 'NO_ACTIVITY'] as const)('does not invent a forecast for %s', async (reason) => {
    const data = usageDashboardFixture();
    data.forecast = { ...data.forecast, tokens: null, costUsd: null, dailyTokens: null, dailyCostUsd: null, reason };
    readUsage = async () => ({ data });
    await renderPage();
    const overview = within(await screen.findByRole('region', { name: 'Monthly usage' }));
    expect(await overview.findByText(reason === 'NO_ACTIVITY' ? /No measured activity yet/ : /At least 24 hours/)).toBeInTheDocument();
    expect(overview.queryByText('$13.50')).not.toBeInTheDocument();
    expect(overview.getAllByText('—')).toHaveLength(2);
  });

  it.each([{ workspaceId: 'other' }, { id: 'other-user' }])('isolates usage and policy drafts when identity changes: %j', async (change) => {
    const qc = await renderPage();
    const card = await actions();
    await card.findByRole('switch', { name: 'Future action: active' });
    await choose('Future action', /^Local/);
    const data = usageDashboardFixture();
    data.totals.tokens = 345;
    readUsage = async () => ({ data });
    await act(async () => useMarketingAuthStore.getState().updateUser(change));
    expect(await screen.findByText('345')).toBeInTheDocument();
    const newCard = await actions();
    expect(await newCard.findByRole('combobox', { name: 'Future action: provider' })).toHaveTextContent('MCP');
    expect(newCard.getByRole('button', { name: 'Save actions' })).toBeDisabled();
    expect(qc.getQueryData(['marketing', 'ai', 'usage-dashboard', change.workspaceId ?? 'workspace', change.id ?? 'owner'])).toBeDefined();
  });
});


describe('usage coverage and polling', () => {
  it.each(['MCP', 'LOCAL'] as const)('shows an unmeasured API-history zero for %s but keeps nonzero API history visible', async (provider) => {
    const data = usageDashboardFixture();
    Object.assign(data.rows[0], { calls: 0, tokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: [] });
    readUsage = async () => ({ data });
    const current = policy();
    current.jobs[0].provider = provider;
    readPolicy = async () => ({ data: current });
    const qc = await renderPage();
    const card = await actions();
    const row = await card.findByRole('row', { name: /Future action/ });
    expect(row).not.toHaveTextContent('$0');
    expect(within(row).getAllByText('—')).toHaveLength(3);
    expect(row).toHaveTextContent('Unmeasured');
    readUsage = async () => ({ data: usageDashboardFixture() });
    await act(async () => { await qc.refetchQueries({ type: 'active' }); });
    await waitFor(() => expect(row).toHaveTextContent('12,000'));
    expect(row).toHaveTextContent('$3.50');
  });

  it('does not imply that entirely unpriced observations cost zero', async () => {
    const data = usageDashboardFixture();
    for (const row of data.rows) Object.assign(row, { costUsd: null, averageCostUsd: null });
    Object.assign(data.totals, { llmCostUsd: 0, mediaCostUsd: 0, knownCostUsd: 0, unpricedCalls: 4, unpricedMediaJobs: 1 });
    data.forecast.costUsd = null;
    readUsage = async () => ({ data });
    await renderPage();
    const overview = within(await screen.findByRole('region', { name: 'Monthly usage' }));
    expect(await overview.findByText(/Cost forecast unavailable/)).toBeInTheDocument();
    expect(overview.queryByText('$0.00')).not.toBeInTheDocument();
    expect(overview.getAllByText('—')).toHaveLength(2);
  });

  it('refreshes every minute only while the page is visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    try {
      await renderPage();
      expect(await screen.findByText('36,000')).toBeInTheDocument();
      vi.useFakeTimers();
      // Recreate the interval after switching clocks; the first one used real timers.
      visibility.mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      visibility.mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      const refreshed = usageDashboardFixture();
      refreshed.totals.tokens = 13000;
      readUsage = async () => ({ data: refreshed });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
      expect(screen.getByText('13,000')).toBeInTheDocument();
      visibility.mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      readUsage = async () => ({ data: { ...refreshed, totals: { ...refreshed.totals, tokens: 14000 } } });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(screen.getByText('13,000')).toBeInTheDocument();
      visibility.mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
      expect(screen.getByText('14,000')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      visibility.mockRestore();
    }
  });
});


it.each([
  { language: 'en', method: 'How usage is measured', overview: 'Monthly usage', detail: 'Future action: details', average: 'USD / priced request' },
  { language: 'tr', method: 'Kullanım nasıl ölçülür?', overview: 'Aylık kullanım', detail: 'Future action: ayrıntılar', average: 'USD / fiyatlı istek' },
])('discloses external research exclusions and priced-call averages in $language', async ({ language, method, overview, detail, average }) => {
  const data = usageDashboardFixture();
  data.rows[0].unpricedCalls = 1;
  data.rows[0].averageCostUsd = 1.75;
  readUsage = async () => ({ data });
  await renderPage(language);
  const summary = within(await screen.findByRole('region', { name: overview }));
  await userEvent.click(await summary.findByText(method));
  expect(summary.getByText(/Firecrawl.*Apify/)).toBeVisible();
  expect(summary.getByText(language === 'tr' ? /oluşturulma tarihine.*READY.*silindiğinde/i : /retained READY.*creation date.*Deleting/i)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: detail }));
  const sheet = within(screen.getByRole('dialog', { name: 'Future action' }));
  expect(sheet.getByText(average)).toBeInTheDocument();
  expect(sheet.getByText(language === 'tr' ? '$1,75' : '$1.75')).toBeInTheDocument();
});

it.each([
  {
    language: 'en', title: 'AI actions', category: 'Category', search: 'Search actions',
    labels: ['Customer conversations', 'Research', 'Content', 'Strategy & brand', 'Panel assistant', 'Automation', 'Voice & calls', 'Review replies', 'Landing pages', 'Social publishing', 'Panel assistant'],
  },
  {
    language: 'tr', title: 'Yapay zeka işlemleri', category: 'Kategori', search: 'İşlem ara',
    labels: ['Müşteri görüşmeleri', 'Araştırma', 'İçerik', 'Strateji ve marka', 'Panel asistanı', 'Otomasyon', 'Ses ve çağrılar', 'Yorum yanıtları', 'Açılış sayfaları', 'Sosyal paylaşım', 'Panel asistanı'],
  },
])('localizes server category codes in the table, filter and search in $language, preserving unknown categories', async ({ language, title, category, search, labels }) => {
  const codes = ['conversation', 'research', 'content', 'strategy', 'assistant', 'workflow', 'voice', 'reviews', 'funnel', 'social', 'askAi', 'future.category'];
  const current = policy();
  current.jobs = codes.map((code, index) => ({ ...current.jobs[0], id: `task.${index}`, label: `Task ${index}`, category: code }));
  readPolicy = async () => ({ data: current });
  readUsage = async () => ({ data: { ...usageDashboardFixture(), rows: [] } });
  await renderPage(language);
  const card = within(await screen.findByRole('region', { name: title }));
  const filter = await card.findByRole('combobox', { name: category });
  for (const [index, label] of [...labels, 'future.category'].entries()) {
    expect(card.getByRole('row', { name: new RegExp(`Task ${index}[: ]`) })).toHaveTextContent(label);
    const option = within(filter).getAllByRole('option', { name: label }).find(node => (node as HTMLOptionElement).value === codes[index]);
    expect(option).toBeDefined();
  }
  await userEvent.type(card.getByRole('searchbox', { name: search }), labels[0]);
  expect(card.getAllByRole('switch')).toHaveLength(1);
  expect(card.getByRole('row', { name: /Task 0/ })).toBeInTheDocument();
  await userEvent.clear(card.getByRole('searchbox', { name: search }));
  await userEvent.selectOptions(filter, 'askAi');
  expect(card.getAllByRole('switch')).toHaveLength(1);
  expect(card.getByRole('row', { name: /Task 10/ })).toBeInTheDocument();
  await userEvent.selectOptions(filter, 'future.category');
  expect(card.getByRole('row', { name: /Task 11/ })).toHaveTextContent('future.category');
});
