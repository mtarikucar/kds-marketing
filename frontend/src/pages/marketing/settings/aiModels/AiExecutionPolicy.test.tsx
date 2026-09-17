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
  readPolicy = async () => ({ data: policy() });
  readPermissions = async () => ({ data: { canToggle: true } });
  vi.mocked(marketingApi.get).mockImplementation(async (url) => {
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
    expect(
      card.getByText("An action added by the server."),
    ).toBeInTheDocument();
    expect(card.getByText("New category")).toBeInTheDocument();
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
      screen.getByRole("radiogroup", { name: "Video model" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Image model" }),
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
    for (const control of card.getAllByRole("combobox"))
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
      screen.getByRole("radiogroup", { name: "Video model" }),
    ).toBeInTheDocument();
    readPolicy = async () => ({ data: policy() });
    await userEvent.click(card.getByRole("button", { name: "Retry" }));
    expect(
      await card.findByRole("switch", { name: "Future action: active" }),
    ).toBeChecked();
  });

  it("does not invent rows when the server returns no actions", async () => {
    readPolicy = async () => ({ data: { ...policy(), jobs: [] } });
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
      expect(card.getByText(mcp)).toBeInTheDocument();
      expect(card.getByText(local)).toBeInTheDocument();
      expect(card.getByText(waiting)).toBeInTheDocument();
      expect(card.getByText(mediaFees)).toBeInTheDocument();
    },
  );
});
