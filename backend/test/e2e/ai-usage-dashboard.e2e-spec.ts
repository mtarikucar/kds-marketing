import request from "supertest";
import {
  createTestApp,
  closeTestApp,
  TestApp,
  mockMarketingUser,
  signMarketingToken,
} from "../utils/test-app";

describe("AI usage dashboard HTTP contract", () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => closeTestApp(ctx?.app));
  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.workspace.findUnique.mockResolvedValue({
      id: "ws-1",
      timezone: "Europe/Istanbul",
      createdAt: new Date("2026-01-01"),
      aiSpendPolicy: {},
      aiApiKeyEnc: "must-never-be-returned",
    } as never);
    (ctx.prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
  });
  const auth = (role: string) => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: "mu-1", wsp: "ws-1", role })}`;
  };
  const endpoint = "/api/marketing/ai/usage-dashboard";
  it("allows a manager to read only their own workspace, ignoring forged tenant parameters", async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`${endpoint}?workspaceId=other`)
      .set("Authorization", auth("MANAGER"));
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
    expect(res.body.rows).toHaveLength(31);
    expect(res.body.forecast.reason).toBe("NO_ACTIVITY");
    const reads = (ctx.prisma.$queryRaw as jest.Mock).mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /FROM (ai_usage_logs|generated_assets)/.test(sql.text));
    expect(reads).toHaveLength(2);
    for (const sql of reads) {
      expect(sql.values).toContain("ws-1");
      expect(sql.values).not.toContain("other");
    }
    expect(JSON.stringify(res.body)).not.toContain("must-never-be-returned");
  });
  it("refuses reps and anonymous readers", async () => {
    expect(
      (
        await request(ctx.app.getHttpServer())
          .get(endpoint)
          .set("Authorization", auth("REP"))
      ).status,
    ).toBe(403);
    expect((await request(ctx.app.getHttpServer()).get(endpoint)).status).toBe(
      401,
    );
  });
  it("returns an error when reporting fails, never a successful zero balance", async () => {
    (ctx.prisma.$queryRaw as jest.Mock).mockRejectedValue(
      new Error("dashboard read unavailable"),
    );
    const res = await request(ctx.app.getHttpServer())
      .get(endpoint)
      .set("Authorization", auth("OWNER"));
    expect(res.status).toBe(500);
    expect(res.body.totals).toBeUndefined();
  });
});
