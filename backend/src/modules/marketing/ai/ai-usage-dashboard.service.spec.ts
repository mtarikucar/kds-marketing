import {
  AiUsageDashboardService,
  dashboardMonth,
} from "./ai-usage-dashboard.service";

describe("compact usage dashboard", () => {
  const now = new Date("2026-09-16T09:00:00.000Z");
  const tokenRow = (over: Record<string, unknown> = {}) => ({
    day: "2026-09-10",
    action: "content.compose",
    model: "claude-sonnet-4-6",
    calls: 2n,
    inputTokens: 1000n,
    outputTokens: 100n,
    cacheWriteTokens: 200n,
    cacheReadTokens: 300n,
    webSearches: 1n,
    ...over,
  });
  function setup(logs: unknown[] = [], media: unknown[] = []) {
    const prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          id: "ws-1",
          timezone: "Europe/Istanbul",
          createdAt: new Date("2026-01-01"),
          aiSpendPolicy: {},
        }),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(logs)
        .mockResolvedValueOnce(media),
    };
    return { prisma, service: new AiUsageDashboardService(prisma as any) };
  }
  it("uses workspace month boundaries, leap years and calendar days across DST", () => {
    const tr = dashboardMonth(
      "Europe/Istanbul",
      new Date("2026-09-30T22:00:00Z"),
    );
    expect(tr).toMatchObject({
      month: "2026-10",
      from: "2026-09-30T21:00:00.000Z",
      totalDays: 31,
    });
    expect(tr.elapsedDays).toBeCloseTo(1 / 24);
    expect(
      dashboardMonth("UTC", new Date("2028-02-15T00:00:00Z")).totalDays,
    ).toBe(29);
    expect(
      dashboardMonth("America/New_York", new Date("2026-03-16T16:00:00Z")),
    ).toMatchObject({
      from: "2026-03-01T05:00:00.000Z",
      elapsedDays: 15.5,
    });
    expect(dashboardMonth("bad/timezone", now).timezone).toBe("UTC");
  });
  it("aggregates all token buckets, search fees and completed media once, with tenant-scoped SQL", async () => {
    const { service, prisma } = setup(
      [tokenRow()],
      [
        {
          day: "2026-09-11",
          type: "VIDEO",
          model: "fal/video",
          calls: 1n,
          costUsd: "0.5",
          unpriced: 0n,
        },
      ],
    );
    const data = await service.get("ws-1", now);
    expect(data.rows.find((r) => r.action === "content.compose")).toMatchObject(
      { tokens: 1600, averageTokens: 800 },
    );
    expect(
      data.rows.find((r) => r.action === "content.compose")!.costUsd,
    ).toBeCloseTo(0.01534, 9);
    expect(data.totals).toMatchObject({
      tokens: 1600,
      calls: 3,
      mediaCostUsd: 0.5,
      unpricedCalls: 0,
      unpricedMediaJobs: 0,
    });
    expect(data.totals.knownCostUsd).toBeCloseTo(0.51534, 9);
    expect(
      data.rows.find((r) => r.action === "media.video.generate"),
    ).toMatchObject({ tokens: null, calls: 1, costUsd: 0.5 });
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ws-1" } }),
    );
    for (const [sql] of prisma.$queryRaw.mock.calls) {
      expect(sql.text).toContain('"workspaceId" =');
      expect(sql.values).toEqual(
        expect.arrayContaining(["ws-1", "Europe/Istanbul"]),
      );
    }
    expect(prisma.$queryRaw.mock.calls[1][0].text).toContain("'READY'");
  });
  it("projects using all elapsed calendar days, including zero-usage days", async () => {
    const { service } = setup([
      tokenRow({
        calls: 1n,
        inputTokens: 15500n,
        outputTokens: 0n,
        cacheWriteTokens: 0n,
        cacheReadTokens: 0n,
        webSearches: 0n,
      }),
    ]);
    const data = await service.get("ws-1", now);
    expect(data.forecast).toMatchObject({
      tokens: 30000,
      dailyTokens: 1000,
      observedDays: 15.5,
      remainingDays: 14.5,
      reason: null,
    });
    expect(data.forecast.costUsd).toBeCloseTo(0.09);
    expect(data.daily).toHaveLength(16);
    expect(data.daily[0]).toMatchObject({
      day: "2026-09-01",
      tokens: 0,
      knownCostUsd: 0,
    });
  });
  it("does not extrapolate a workspace with less than 24h of history", async () => {
    const { service, prisma } = setup([tokenRow()]);
    prisma.workspace.findUnique.mockResolvedValue({
      timezone: "Europe/Istanbul",
      createdAt: new Date("2026-09-16T03:00:00Z"),
    });
    expect((await service.get("ws-1", now)).forecast).toMatchObject({
      tokens: null,
      costUsd: null,
      observedDays: 0.25,
      reason: "INSUFFICIENT_HISTORY",
    });
  });
  it("does not invent prices, MCP usage, external-service usage or entry-fee tokens", async () => {
    const { service } = setup([tokenRow({ model: "unknown-model" })]);
    const data = await service.get("ws-1", now);
    expect(data.rows.find((r) => r.action === "content.compose")).toMatchObject(
      { tokens: 1600, costUsd: null, unpricedCalls: 2 },
    );
    expect(data.rows.find((r) => r.action === "stt.minute")).toMatchObject({
      kind: "EXTERNAL",
      calls: null,
      tokens: null,
      costUsd: null,
    });
    expect(data.rows.find((r) => r.action === "command.request")).toMatchObject(
      { kind: "ENTRY", tokens: null, costUsd: null },
    );
    expect(data.totals.unpricedCalls).toBe(2);
    expect(data.forecast.costUsd).toBeNull();
    expect(data.coverage.partial).toBe(true);
    expect(data.coverage.untrackedActions).toContain("social.publish.x");
  });
  it("keeps historical uncatalogued actions and media with missing costs visible", async () => {
    const { service } = setup(
      [tokenRow({ action: "retired.action" })],
      [
        {
          day: "2026-09-11",
          type: "IMAGE",
          model: "unknown/image",
          calls: 2n,
          costUsd: null,
          unpriced: 2n,
        },
      ],
    );
    const data = await service.get("ws-1", now);
    expect(data.rows.find((r) => r.action === "retired.action")!.tokens).toBe(
      1600,
    );
    expect(data.coverage.unmappedActions).toEqual(["retired.action"]);
    expect(
      data.rows.find((r) => r.action === "media.image.generate"),
    ).toMatchObject({ calls: 2, costUsd: null, unpricedCalls: 2 });
    expect(data.totals.unpricedMediaJobs).toBe(2);
  });
  it("returns every job even without activity, without a misleading projection", async () => {
    const { service } = setup();
    const data = await service.get("ws-1", now);
    expect(data.rows).toHaveLength(31);
    expect(data.forecast).toMatchObject({
      reason: "NO_ACTIVITY",
      tokens: null,
      costUsd: null,
    });
    expect(data.rows.find((r) => r.action === "brand.safety")!.creditRate).toBe(
      1,
    );
  });
  it("allows a forecast after 24 real hours across the fall DST transition", async () => {
    const { service, prisma } = setup([tokenRow({ day: "2026-11-01" })]);
    prisma.workspace.findUnique.mockResolvedValue({
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01"),
    });
    const data = await service.get("ws-1", new Date("2026-11-02T04:00:00Z"));
    expect(data.forecast.observedDays).toBeCloseTo(23 / 24);
    expect(data.forecast.reason).toBeNull();
    expect(data.forecast.tokens).toBeGreaterThan(0);
  });
  it("propagates read failures instead of fabricating a zero-spend report", async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw
      .mockReset()
      .mockRejectedValue(new Error("database offline"));
    await expect(service.get("ws-1", now)).rejects.toThrow("database offline");
  });
});
