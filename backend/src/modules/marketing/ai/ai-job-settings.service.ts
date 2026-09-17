import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  AI_JOBS,
  RUNNER_SIBLINGS,
  jobPolicy,
  validateJobPatch,
} from "./ai-job-policy";
import {
  mcpActivityCutoff,
  MCP_ACTIVITY_AGENT,
} from "../research/research-execution";
import { effectiveResearchExecution } from "../research/research-execution";
import { effectiveAiExecution } from "./ai-execution";

@Injectable()
export class AiJobSettingsService {
  constructor(private readonly prisma: PrismaService) {}
  async get(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        aiSpendPolicy: true,
        aiApiKeyEnc: true,
        aiExecution: true,
        researchExecution: true,
      },
    });
    const policy = ws?.aiSpendPolicy as Record<string, unknown> | null;
    const seen = await this.prisma.agentRun.findFirst({
      where: {
        workspaceId,
        agent: MCP_ACTIVITY_AGENT,
        startedAt: { gt: mcpActivityCutoff() },
      },
      select: { id: true },
    });
    const localConfigured = !!(
      process.env.LOCAL_AI_URL && process.env.LOCAL_AI_TOKEN
    );
    const apiConfigured = !!(ws?.aiApiKeyEnc || process.env.ANTHROPIC_API_KEY);
    return {
      jobs: Object.entries(AI_JOBS).map(([id, def]) => {
        let api = apiConfigured;
        if (id.startsWith("research.native_"))
          api = !!process.env.ANTHROPIC_API_KEY;
        if (id.startsWith("media."))
          api = !!(process.env.FAL_KEY || process.env.RUNWARE_API_KEY);
        if (id.startsWith("social."))
          api = !!(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);
        if (id === "stt.minute")
          api = !!(process.env.STT_PROVIDER && process.env.STT_API_KEY);
        const decision = jobPolicy(policy, id);
        if (
          !decision.explicit &&
          id.startsWith("conversation.") &&
          !ws?.aiApiKeyEnc
        ) {
          decision.provider =
            effectiveAiExecution(ws?.aiExecution, !!seen) === "SERVER"
              ? "API"
              : "MCP";
        }
        if (
          !decision.explicit &&
          ["research.turn", "research.qualify"].includes(id)
        ) {
          decision.provider =
            effectiveResearchExecution(ws?.researchExecution, !!seen) ===
            "SERVER"
              ? "API"
              : "MCP";
        }
        return {
          id,
          ...def,
          ...decision,
          availability: {
            API: api,
            MCP: !!seen,
            LOCAL: localConfigured && def.providers.includes("LOCAL"),
          },
        };
      }),
      local: {
        configured: localConfigured,
        models: {
          classify: "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli",
          transcribe: process.env.LOCAL_AI_WHISPER_SIZE || "base",
        },
      },
      mcp: { connected: !!seen },
    };
  }
  async set(workspaceId: string, body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => k !== "jobs")
    )
      throw new BadRequestException("Expected { jobs: { action: settings } }");
    const patch = validateJobPatch((body as any).jobs);
    // A loop's entry fee and its turns are one execution. Keep their runner
    // consistent so neither the server nor the connected assistant rejects it.
    for (const [id, choice] of Object.entries(patch)) {
      const sibling = RUNNER_SIBLINGS[id];
      if (!sibling || !choice.provider) continue;
      if (
        patch[sibling]?.provider &&
        patch[sibling].provider !== choice.provider
      ) {
        throw new BadRequestException(
          `${id} and ${sibling} must use the same provider`,
        );
      }
      patch[sibling] = { ...patch[sibling], provider: choice.provider };
    }
    await this.prisma.$transaction(async (tx) => {
      // Serialize policy patches; two tabs editing different rows must not erase one another.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-policy:${workspaceId}`}))::text AS locked`;
      const ws = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { aiSpendPolicy: true },
      });
      const current = (ws?.aiSpendPolicy ?? {}) as Record<string, any>;
      const jobs = { ...(current.jobs ?? {}) };
      for (const [id, choice] of Object.entries(patch))
        jobs[id] = { ...(jobs[id] ?? {}), ...choice };
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { aiSpendPolicy: { ...current, jobs } as any },
      });
    });
    return this.get(workspaceId);
  }
}
