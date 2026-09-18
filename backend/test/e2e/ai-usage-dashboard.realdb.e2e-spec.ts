import { PrismaClient } from "@prisma/client";
import { AiUsageDashboardService } from "../../src/modules/marketing/ai/ai-usage-dashboard.service";

// Transaction-local fixtures disappear at commit/rollback. Never changes application data.
const describeDb = process.env.E2E_REAL_DB === "1" ? describe : describe.skip;
describeDb("AI dashboard PostgreSQL aggregation", () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());
  it("honours local month/day boundaries, workspace isolation, final costs and unknown prices", async () => {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`CREATE TEMP TABLE ai_usage_logs (
        "workspaceId" text, action text, model text, "inputTokens" int, "outputTokens" int,
        "cacheWriteTokens" int, "cacheReadTokens" int, "webSearches" int, "createdAt" timestamp(3)
      ) ON COMMIT DROP`;
        await tx.$executeRaw`CREATE TEMP TABLE generated_assets (
        "workspaceId" text, type text, model text, status text, "costUsd" numeric(10,4), "createdAt" timestamp(3)
      ) ON COMMIT DROP`;
        await tx.$executeRaw`INSERT INTO ai_usage_logs VALUES
        ('mine','content.compose','claude-sonnet-4-6',1000,100,200,300,1,'2026-08-31 21:00:00'),
        ('mine','content.compose','claude-sonnet-4-6',1000,100,200,300,1,'2026-09-01 20:59:59'),
        ('mine','content.compose','claude-sonnet-4-6',1000,100,200,300,1,'2026-09-01 21:00:00'),
        ('mine','content.compose','unknown-model',100,0,0,0,0,'2026-09-02 01:00:00'),
        ('mine','content.compose','claude-sonnet-4-6',90000,0,0,0,0,'2026-08-31 20:59:59'),
        ('mine','content.compose','claude-sonnet-4-6',90000,0,0,0,0,'2026-10-01 00:00:00'),
        ('other','content.compose','claude-sonnet-4-6',90000,0,0,0,0,'2026-09-02 00:00:00')`;
        await tx.$executeRaw`INSERT INTO generated_assets VALUES
        ('mine','VIDEO','fal/video','READY',0.5000,'2026-09-01 21:00:00'),
        ('mine','VIDEO','fal/video','READY',NULL,'2026-09-02 01:00:00'),
        ('mine','VIDEO','fal/video','GENERATING',500,'2026-09-02 01:00:00'),
        ('mine','VIDEO','fal/video','FAILED',500,'2026-09-02 01:00:00'),
        ('other','VIDEO','fal/video','READY',500,'2026-09-02 01:00:00'),
        ('mine','IMAGE','fal/image','READY',500,'2026-08-31 20:59:59')`;
        const service = new AiUsageDashboardService({
          workspace: {
            findUnique: async () => ({
              timezone: "Europe/Istanbul",
              createdAt: new Date("2026-01-01"),
              aiSpendPolicy: {},
            }),
          },
          $queryRaw: tx.$queryRaw.bind(tx),
        } as any);
        const report = await service.get(
          "mine",
          new Date("2026-09-16T09:00:00Z"),
        );
        expect(report.totals).toMatchObject({
          tokens: 4900,
          calls: 6,
          mediaCostUsd: 0.5,
          unpricedCalls: 1,
          unpricedMediaJobs: 1,
        });
        expect(report.totals.llmCostUsd).toBeCloseTo(3 * 0.01534, 9);
        expect(report.daily[0]).toMatchObject({
          day: "2026-09-01",
          tokens: 3200,
          calls: 2,
        });
        expect(report.daily[1]).toMatchObject({
          day: "2026-09-02",
          tokens: 1700,
          calls: 4,
          mediaCostUsd: 0.5,
        });
        const video = report.rows.find(
          (r) => r.action === "media.video.generate",
        )!;
        expect(video).toMatchObject({
          calls: 2,
          tokens: null,
          costUsd: 0.5,
          averageCostUsd: 0.5,
          unpricedCalls: 1,
        });
        expect(video.models[0]).toMatchObject({
          priceKnown: false,
          costUsd: 0.5,
        });
        expect(report.forecast.costUsd).toBeCloseTo(
          ((0.5 + 3 * 0.01534) * 30) / 15.5,
        );
      },
      { timeout: 15000 },
    );
  });
});
