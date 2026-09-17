import { spendAllowed } from "./ai-spend-policy";
import { AI_CREDIT_COSTS } from "./ai-credit-costs";
import {
  AI_JOBS,
  assertJobProvider,
  jobPolicy,
  validateJobPatch,
} from "./ai-job-policy";
describe("AI job execution policy", () => {
  it("switches off one job without silencing another in the same category", () => {
    const policy = {
      jobs: { "conversation.followup": { enabled: false, provider: "MCP" } },
    };
    expect(spendAllowed(policy, "conversation.followup")).toBe(false);
    expect(spendAllowed(policy, "conversation.reply")).toBe(true);
  });
  it("preserves category settings until explicitly overridden per job", () => {
    expect(jobPolicy({ research: false }, "research.turn").enabled).toBe(false);
    expect(
      jobPolicy(
        {
          research: false,
          jobs: { "research.turn": { enabled: true, provider: "MCP" } },
        },
        "research.turn",
      ),
    ).toMatchObject({ enabled: true, provider: "MCP" });
  });
  it("covers every metered action and separates audio and brand safety", () => {
    for (const id of Object.keys(AI_CREDIT_COSTS))
      expect(AI_JOBS[id]).toBeDefined();
    expect(AI_JOBS["media.audio.generate"]).toBeDefined();
    expect(AI_JOBS["brand.safety"]).toBeDefined();
  });
  it("limits local inference to suitable tasks", () => {
    expect(
      validateJobPatch({
        "workflow.ai_classify": { provider: "LOCAL" },
        "stt.minute": { provider: "LOCAL" },
      }),
    ).toBeDefined();
    expect(() =>
      validateJobPatch({ "conversation.reply": { provider: "LOCAL" } }),
    ).toThrow();
    expect(() =>
      validateJobPatch({ "brand.safety": { provider: "LOCAL" } }),
    ).toThrow();
  });
  it("uses the selected runner for a loop and its entry fee unless separately overridden", () => {
    const policy = {
      jobs: { "ask_ai.question": { provider: "MCP" as const } },
    };
    expect(jobPolicy(policy, "ask_ai.turn")).toMatchObject({
      provider: "MCP",
      explicit: true,
    });
    expect(
      jobPolicy(
        { jobs: { "ask_ai.turn": { provider: "MCP" } } },
        "ask_ai.question",
      ).provider,
    ).toBe("MCP");
    expect(
      jobPolicy(
        { jobs: { ...policy.jobs, "ask_ai.turn": { provider: "API" } } },
        "ask_ai.turn",
      ).provider,
    ).toBe("API");
    expect(jobPolicy(policy, "content.compose").provider).toBe("API");
  });
  it("rejects unknown or malformed settings", () => {
    for (const patch of [
      null,
      [],
      { unknown: { enabled: false } },
      { "research.turn": { enabled: "false" } },
      { "research.turn": { provider: "AUTO" } },
      { "research.turn": { typo: true } },
    ])
      expect(() => validateJobPatch(patch)).toThrow();
  });
  it("refuses unsupported persisted providers at the invocation boundary", async () => {
    const prisma = {
      workspace: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            aiSpendPolicy: { jobs: { "stt.minute": { provider: "MCP" } } },
          }),
      },
    };
    await expect(
      assertJobProvider(prisma as any, "ws", "stt.minute"),
    ).rejects.toThrow("sağlayıcı");
  });
});
