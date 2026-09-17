import { AiJobSettingsService } from "./ai-job-settings.service";
describe("AI job settings", () => {
  function setup(policy: any = {}) {
    const prisma: any = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ aiSpendPolicy: policy }),
        update: jest.fn().mockResolvedValue({}),
      },
      agentRun: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn(),
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    return { prisma, svc: new AiJobSettingsService(prisma) };
  }
  it("preserves other action and category settings during a partial patch", async () => {
    const { prisma, svc } = setup({
      research: false,
      jobs: { "content.compose": { provider: "MCP" } },
    });
    await svc.set("ws", { jobs: { "conversation.reply": { enabled: false } } });
    expect(prisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ws" },
        data: {
          aiSpendPolicy: {
            research: false,
            jobs: {
              "content.compose": { provider: "MCP" },
              "conversation.reply": { enabled: false },
            },
          },
        },
      }),
    );
  });
  it("validates unsupported local generation before touching persistent state", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.set("ws", { jobs: { "content.compose": { provider: "LOCAL" } } }),
    ).rejects.toThrow();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });
  it("shows inherited conversation MCP instead of claiming the API is selected", async () => {
    const { svc, prisma } = setup();
    prisma.workspace.findUnique.mockResolvedValue({ aiExecution: "MCP_ONLY" });
    const result = await svc.get("ws");
    expect(
      result.jobs.find((j) => j.id === "conversation.reply"),
    ).toMatchObject({ provider: "MCP", explicit: false });
  });
  it("keeps a loop and its entry fee on the same runner after a provider change", async () => {
    const { prisma, svc } = setup({
      jobs: { "research.turn": { provider: "API" } },
    });
    await svc.set("ws", { jobs: { "research.qualify": { provider: "MCP" } } });
    expect(
      prisma.workspace.update.mock.calls[0][0].data.aiSpendPolicy.jobs,
    ).toEqual({
      "research.turn": { provider: "MCP" },
      "research.qualify": { provider: "MCP" },
    });
    await expect(
      svc.set("ws", {
        jobs: {
          "research.qualify": { provider: "MCP" },
          "research.turn": { provider: "API" },
        },
      }),
    ).rejects.toThrow("same provider");
  });
  it("lists all jobs without exposing an API key", async () => {
    const { svc } = setup();
    const res = await svc.get("ws");
    expect(res.jobs.find((j) => j.id === "media.audio.generate")).toMatchObject(
      { enabled: true, providers: ["API"] },
    );
    expect(res.mcp.connected).toBe(false);
    expect(JSON.stringify(res)).not.toContain("aiApiKeyEnc");
  });
});
