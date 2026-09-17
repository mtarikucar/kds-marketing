import { execFileSync } from "node:child_process";
import { ScheduledJobRunnerService } from "./scheduled-job-runner.service";
import { RESEARCH_MANUAL_KEY } from "../research/research-kinds";

// Opt-in, isolated SQL test: only transaction-local temporary tables are used;
// ROLLBACK removes every fixture. No application tables or migrations required.
const container = process.env.AI_JOB_POLICY_SQL_CONTAINER;
const describeSql = container ? describe : describe.skip;

describeSql(
  "ScheduledJobRunnerService — per-action PostgreSQL claim matrix",
  () => {
    it("claims exactly the allowed jobs, keeping strict choices separate from legacy fallback", async () => {
      type Case = {
        id: string;
        kind?: string;
        action?: string;
        choice?: Record<string, unknown>;
        policy?: Record<string, unknown>;
        ai?: string | null;
        research?: string | null;
        old?: boolean;
        connected?: boolean;
        ownKey?: boolean;
        payload?: Record<string, unknown>;
        want: boolean;
      };
      const cases: Case[] = [
        { id: "legacy-server", ai: "SERVER", want: true },
        { id: "legacy-mcp-young", ai: "MCP", want: false },
        { id: "legacy-mcp-old", ai: "MCP", old: true, want: true },
        { id: "legacy-mcp-only-old", ai: "MCP_ONLY", old: true, want: false },
        {
          id: "legacy-auto-connected",
          ai: "AUTO",
          connected: true,
          want: false,
        },
        { id: "legacy-auto-alone", ai: "AUTO", want: true },
        {
          id: "explicit-api",
          ai: "MCP_ONLY",
          choice: { provider: "API" },
          want: true,
        },
        {
          id: "explicit-mcp-old-byok",
          ai: "SERVER",
          choice: { provider: "MCP" },
          old: true,
          ownKey: true,
          want: false,
        },
        {
          id: "reply-disabled",
          choice: { enabled: false, provider: "API" },
          want: false,
        },
        {
          id: "legacy-category-off",
          policy: { conversation: false },
          want: false,
        },
        {
          id: "action-overrides-category",
          policy: {
            conversation: false,
            jobs: { "conversation.reply": { enabled: true, provider: "API" } },
          },
          want: true,
        },
        {
          id: "nonboolean-inherits-category",
          policy: {
            conversation: false,
            jobs: { "conversation.reply": { enabled: "true" } },
          },
          want: false,
        },
        {
          id: "nonboolean-is-not-disabled",
          choice: { enabled: "false" },
          want: true,
        },
        {
          id: "queued-followup-api",
          ai: "MCP_ONLY",
          payload: { reason: "followup" },
          policy: {
            jobs: {
              "conversation.reply": { enabled: false, provider: "MCP" },
              "conversation.followup": { enabled: true, provider: "API" },
            },
          },
          want: true,
        },
        {
          id: "queued-followup-mcp",
          old: true,
          payload: { reason: "followup" },
          policy: {
            jobs: {
              "conversation.reply": { provider: "API" },
              "conversation.followup": { provider: "MCP" },
            },
          },
          want: false,
        },
        {
          id: "queued-followup-disabled",
          payload: { reason: "followup" },
          policy: { jobs: { "conversation.followup": { enabled: false } } },
          want: false,
        },
        {
          id: "followup-handoff",
          kind: "conversation.followup",
          action: "conversation.followup",
          choice: { provider: "MCP" },
          want: true,
        },
        {
          id: "followup-trigger-disabled",
          kind: "conversation.followup",
          action: "conversation.followup",
          choice: { enabled: false },
          want: false,
        },
        {
          id: "other-kind-unaffected",
          kind: "reminder",
          policy: { conversation: false, research: false },
          want: true,
        },
        {
          id: "research-legacy-server",
          kind: "research.run",
          research: "SERVER",
          want: true,
        },
        {
          id: "research-legacy-mcp-young",
          kind: "research.run",
          research: "MCP",
          want: false,
        },
        {
          id: "research-legacy-mcp-old",
          kind: "research.run",
          research: "MCP",
          old: true,
          want: true,
        },
        {
          id: "research-legacy-manual",
          kind: "research.run",
          research: "MCP",
          payload: { [RESEARCH_MANUAL_KEY]: true },
          want: true,
        },
        {
          id: "research-auto-connected",
          kind: "research.run",
          research: "AUTO",
          connected: true,
          want: false,
        },
        {
          id: "research-auto-alone",
          kind: "research.run",
          research: "AUTO",
          want: true,
        },
        {
          id: "research-category-off",
          kind: "research.run",
          policy: { research: false },
          old: true,
          want: false,
        },
        {
          id: "research-only-one-enabled",
          kind: "research.run",
          policy: {
            research: false,
            jobs: { "research.turn": { enabled: true, provider: "API" } },
          },
          want: false,
        },
        {
          id: "research-both-enabled",
          kind: "research.run",
          policy: {
            research: false,
            jobs: {
              "research.turn": { enabled: true, provider: "API" },
              "research.qualify": { enabled: true, provider: "API" },
            },
          },
          want: true,
        },
        {
          id: "research-mixed-providers",
          kind: "research.run",
          old: true,
          policy: {
            jobs: {
              "research.turn": { provider: "MCP" },
              "research.qualify": { provider: "API" },
            },
          },
          want: false,
        },
      ];
      for (const action of ["research.turn", "research.qualify"]) {
        cases.push(
          {
            id: `${action}-api`,
            kind: "research.run",
            research: "MCP",
            action,
            choice: { provider: "API" },
            want: true,
          },
          {
            id: `${action}-mcp-old`,
            kind: "research.run",
            research: "SERVER",
            action,
            choice: { provider: "MCP" },
            old: true,
            want: false,
          },
          {
            id: `${action}-mcp-manual`,
            kind: "research.run",
            action,
            choice: { provider: "MCP" },
            payload: { [RESEARCH_MANUAL_KEY]: true },
            old: true,
            want: false,
          },
          {
            id: `${action}-disabled`,
            kind: "research.run",
            action,
            choice: { enabled: false },
            old: true,
            want: false,
          },
        );
      }

      const literal = (value: unknown): string =>
        value === null
          ? "NULL"
          : `'${String(value instanceof Date ? value.toISOString() : value).replace(/'/g, "''")}'`;
      const now = new Date();
      const workspaces = cases
        .map(
          (c) =>
            `(${literal(c.id)}, ${literal(c.ai ?? "SERVER")}, ${literal(c.research ?? "SERVER")}, ${literal(c.ownKey ? "own-key" : null)}, ${literal(JSON.stringify(c.policy ?? (c.choice ? { jobs: { [c.action ?? "conversation.reply"]: c.choice } } : {})))}::jsonb)`,
        )
        .join(",");
      const jobs = cases
        .map(
          (c) =>
            `(${literal(c.id)}, ${literal(c.id)}, ${literal(c.kind ?? "conversation.ai_reply")}, ${literal(JSON.stringify(c.payload ?? {}))}::jsonb, 'PENDING', ${literal(new Date(now.getTime() - 1000))}::timestamptz, ${literal(new Date(now.getTime() - (c.old ? 8 * 3600_000 : 1000)))}::timestamptz, NULL, 0)`,
        )
        .join(",");
      const activity = cases
        .filter((c) => c.connected)
        .map((c) => `(${literal(c.id)}, 'mcp', ${literal(now)}::timestamptz)`)
        .join(",");
      const prisma = {
        $queryRaw: async (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => {
          const query = strings.reduce(
            (text, fragment, i) =>
              text + (i ? literal(values[i - 1]) : "") + fragment,
            "",
          );
          const sql = `BEGIN;
          CREATE TEMP TABLE workspaces (id text, "aiExecution" text, "researchExecution" text, "aiApiKeyEnc" text, "aiSpendPolicy" jsonb);
          CREATE TEMP TABLE scheduled_jobs (id text, "workspaceId" text, kind text, payload jsonb, status text, "runAt" timestamptz, "createdAt" timestamptz, "lockedAt" timestamptz, attempts int);
          CREATE TEMP TABLE agent_runs ("workspaceId" text, agent text, "startedAt" timestamptz);
          INSERT INTO workspaces VALUES ${workspaces};
          INSERT INTO scheduled_jobs VALUES ${jobs};
          INSERT INTO agent_runs VALUES ${activity};
          ${query}
          ROLLBACK;`;
          const result = execFileSync(
            "docker",
            [
              "exec",
              "-i",
              container!,
              "sh",
              "-c",
              'psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d template1',
            ],
            { input: sql, encoding: "utf8", timeout: 15_000 },
          );
          return result
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => ({ id: line.split("|")[0] }));
        },
      };
      const runner = new ScheduledJobRunnerService(prisma as any);
      const claimed = await (runner as any).claimBatch();
      expect(claimed.map((row: { id: string }) => row.id).sort()).toEqual(
        cases
          .filter((c) => c.want)
          .map((c) => c.id)
          .sort(),
      );
    });
  },
);
