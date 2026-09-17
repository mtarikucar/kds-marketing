import request from "supertest";
import {
  createTestApp,
  closeTestApp,
  TestApp,
  mockMarketingUser,
  signMarketingToken,
} from "../utils/test-app";

describe("AI execution settings HTTP contract", () => {
  let ctx: TestApp;
  let policy: Record<string, unknown>;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => closeTestApp(ctx?.app));
  beforeEach(() => {
    jest.clearAllMocks();
    policy = { research: false };
    ctx.prisma.workspace.findUnique.mockImplementation(
      async () =>
        ({
          id: "ws-1",
          aiSpendPolicy: policy,
          aiApiKeyEnc: "sealed-secret",
        }) as never,
    );
    ctx.prisma.workspace.update.mockImplementation(async ({ data }: any) => {
      policy = data.aiSpendPolicy;
      return { id: "ws-1" } as never;
    });
    (ctx.prisma.$transaction as jest.Mock).mockImplementation((fn) =>
      fn(ctx.prisma),
    );
  });
  const auth = (role = "OWNER") => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: "mu-1", wsp: "ws-1", role })}`;
  };
  const endpoint = "/api/marketing/ai/execution-policy";

  it("persists an owner choice only in the authenticated workspace and never returns keys", async () => {
    const res = await request(ctx.app.getHttpServer())
      .patch(endpoint)
      .set("Authorization", auth())
      .send({
        jobs: { "content.compose": { enabled: true, provider: "MCP" } },
      });
    expect(res.status).toBe(200);
    expect(
      res.body.jobs.find((job: any) => job.id === "content.compose"),
    ).toMatchObject({ enabled: true, provider: "MCP", explicit: true });
    expect(JSON.stringify(res.body)).not.toContain("sealed-secret");
    expect(ctx.prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: {
        aiSpendPolicy: {
          research: false,
          jobs: { "content.compose": { enabled: true, provider: "MCP" } },
        },
      },
    });
  });
  it("allows a manager to read but not change execution", async () => {
    const token = auth("MANAGER");
    expect(
      (
        await request(ctx.app.getHttpServer())
          .get(endpoint)
          .set("Authorization", token)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app.getHttpServer())
          .patch(endpoint)
          .set("Authorization", token)
          .send({ jobs: {} })
      ).status,
    ).toBe(403);
    expect(ctx.prisma.workspace.update).not.toHaveBeenCalled();
  });
  it("refuses a rep and unauthenticated requests", async () => {
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
  it.each([
    { workspaceId: "neighbour", jobs: {} },
    { jobs: { "conversation.reply": { provider: "LOCAL" } } },
    { jobs: { "research.turn": { enabled: "false" } } },
  ])(
    "rejects unsupported or forged settings before writing: %j",
    async (body) => {
      const res = await request(ctx.app.getHttpServer())
        .patch(endpoint)
        .set("Authorization", auth())
        .send(body);
      expect(res.status).toBe(400);
      expect(ctx.prisma.workspace.update).not.toHaveBeenCalled();
    },
  );
});
