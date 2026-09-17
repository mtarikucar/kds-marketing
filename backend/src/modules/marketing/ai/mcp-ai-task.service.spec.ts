import { McpAiTaskService } from "./mcp-ai-task.service";
import { CommandAiService } from "./command-ai.service";
import { AskAiService } from "./ask-ai.service";
import { z } from "zod";
describe("MCP inference tasks", () => {
  function setup() {
    const prisma: any = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          aiSpendPolicy: {
            jobs: { "content.compose": { provider: "MCP", enabled: true } },
          },
        }),
      },
      scheduledJob: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn(),
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    return { prisma, svc: new McpAiTaskService(prisma) };
  }
  it("rejects a completion belonging to another workspace", async () => {
    const { prisma, svc } = setup();
    prisma.scheduledJob.findFirst.mockResolvedValue(null);
    await expect(
      svc.complete("other", "job", "token", {
        text: "x",
        toolUses: [],
        stopReason: "end_turn",
        usage: { input: 0, output: 0 },
      }),
    ).rejects.toThrow();
    expect(prisma.scheduledJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "other" }),
      }),
    );
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
  });
  it("refuses a stale lease and an undeclared tool instead of applying generated work", async () => {
    const { prisma, svc } = setup();
    prisma.scheduledJob.findFirst.mockResolvedValue({
      id: "j",
      status: "MCP_CLAIMED",
      lockedAt: new Date(),
      payload: {
        action: "content.compose",
        leaseToken: "ok",
        input: { tools: [{ name: "allowed" }] },
      },
    });
    await expect(
      svc.complete("ws", "j", "wrong", { text: "x", toolUses: [] }),
    ).rejects.toThrow();
    await expect(
      svc.complete("ws", "j", "ok", {
        text: "",
        toolUses: [{ id: "1", name: "forbidden", type: "tool_use", input: {} }],
      }),
    ).rejects.toThrow();
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
  });
  it("rechecks the off switch when a connected assistant completes a task", async () => {
    const { prisma, svc } = setup();
    prisma.workspace.findUnique.mockResolvedValue({
      aiSpendPolicy: {
        jobs: { "content.compose": { enabled: false, provider: "MCP" } },
      },
    });
    prisma.scheduledJob.findFirst.mockResolvedValue({
      id: "j",
      status: "MCP_CLAIMED",
      lockedAt: new Date(),
      payload: { action: "content.compose", leaseToken: "ok", input: {} },
    });
    await expect(
      svc.complete("ws", "j", "ok", { text: "x", toolUses: [] }),
    ).rejects.toThrow();
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
  });
});

/** In-memory rows with transaction serialization and conditional updates. No DB/network. */
function mailbox() {
  const rows: any[] = [];
  const clone = (v: any) => structuredClone(v);
  // PostgreSQL JSONB containment permits partial objects within an array.
  const contains = (actual: any, expected: any): boolean =>
    Array.isArray(expected)
      ? Array.isArray(actual) &&
        expected.every((item) => actual.some((value) => contains(value, item)))
      : expected && typeof expected === "object"
        ? !!actual &&
          Object.entries(expected).every(([key, value]) =>
            contains(actual[key], value),
          )
        : actual === expected;
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === "OR")
        return value.some((clause: any) => matches(row, clause));
      const actual = row[key];
      if (Object.prototype.toString.call(value) === "[object Date]")
        return +actual === +value;
      if (value && typeof value === "object") {
        if (value.in) return value.in.includes(actual);
        if (value.gt) return +actual > +value.gt;
        if (value.lte) return +actual <= +value.lte;
        if (value.path) {
          const atPath = value.path.reduce(
            (v: any, p: string) => v?.[p],
            actual,
          );
          return "array_contains" in value
            ? contains(atPath, value.array_contains)
            : atPath === value.equals;
        }
        if ("equals" in value)
          return JSON.stringify(actual) === JSON.stringify(value.equals);
      }
      return actual === value;
    });
  const prisma: any = {
    workspace: {
      findUnique: jest.fn(async () => ({
        aiSpendPolicy: {
          jobs: {
            "command.turn": { provider: "MCP" },
            "content.compose": { provider: "MCP" },
          },
        },
      })),
    },
    $queryRaw: jest.fn(),
    scheduledJob: {
      findFirst: jest.fn(async ({ where }: any) =>
        clone(rows.find((r) => matches(r, where)) ?? null),
      ),
      findMany: jest.fn(async ({ where, take }: any) =>
        clone(rows.filter((r) => matches(r, where)).slice(0, take)),
      ),
      count: jest.fn(
        async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `task-${rows.length + 1}`,
          createdAt: new Date(),
          ...clone(data),
        };
        rows.push(row);
        return clone(row);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const selected = rows.filter((r) => matches(r, where));
        for (const row of selected) Object.assign(row, clone(data));
        return { count: selected.length };
      }),
    },
  };
  let tail = Promise.resolve();
  prisma.$transaction = jest.fn((fn) => {
    const result = tail.then(() => fn(prisma));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  return { rows, prisma, tasks: new McpAiTaskService(prisma) };
}

describe("MCP durable retry", () => {
  const opts: any = {
    workspaceId: "ws",
    action: "command.turn",
    idempotencyScope: "actor:a",
    system: "s",
    messages: [{ role: "user", content: "write once" }],
    tools: [{ name: "write", input_schema: { type: "object" } }],
  };
  const tool = { type: "tool_use", id: "write-1", name: "write", input: {} };
  const pending = { response: { code: "AI_MCP_WAITING" } };
  let oldWait: string | undefined;
  beforeEach(() => {
    oldWait = process.env.AI_MCP_WAIT_MS;
    process.env.AI_MCP_WAIT_MS = "0";
  });
  afterEach(() => {
    if (oldWait === undefined) delete process.env.AI_MCP_WAIT_MS;
    else process.env.AI_MCP_WAIT_MS = oldWait;
  });

  async function ready(m: ReturnType<typeof mailbox>) {
    await expect(m.tasks.generate(opts)).rejects.toMatchObject(pending);
    const claim = await m.tasks.claim("ws");
    await m.tasks.complete("ws", claim!.taskId, claim!.leaseToken, {
      text: "",
      toolUses: [tool],
    });
    return m.tasks.generate(opts);
  }

  it("bounds the wait even when the operator supplies a nonnumeric duration", async () => {
    jest.useFakeTimers();
    process.env.AI_MCP_WAIT_MS = "invalid";
    try {
      const m = mailbox();
      let outcome: unknown;
      const work = m.tasks.generate(opts).catch((error) => {
        outcome = error;
      });
      await jest.advanceTimersByTimeAsync(20_500);
      expect(outcome).toMatchObject(pending);
      await work;
    } finally {
      jest.useRealTimers();
    }
  });

  it("replays a multi-turn command after timeout without repeating its authorized write", async () => {
    const m = mailbox();
    const anthropic: any = {
      isEnabledFor: async () => true,
      complete: (o: any) => m.tasks.generate(o),
      runMcpToolOnce: (...args: any[]) => (m.tasks as any).runToolOnce(...args),
    };
    const broker = {
      invoke: jest.fn(async (..._args: any[]) => ({
        status: "OK",
        result: { id: "new-lead", nested: { b: 2, a: 1 } },
      })),
    };
    const roles = { resolvePermissions: jest.fn(async () => ["leads.write"]) };
    const service = new CommandAiService(
      {
        workspace: { findUnique: async () => ({ mcpWriteMode: "AUTONOMOUS" }) },
      } as any,
      anthropic,
      { reserveForJob: async () => 0, refund: async () => {} } as any,
      {
        listAdvertised: () => [
          {
            name: "jeeta.write",
            description: "write",
            inputSchema: z.object({}),
          },
        ],
      } as any,
      broker as any,
      { start: async () => "run", finish: async () => {} } as any,
      roles as any,
    );
    const actor = { id: "alice", role: "OWNER" };
    await expect(service.run("ws", "create lead", actor)).rejects.toMatchObject(
      pending,
    );
    let claim = await m.tasks.claim("ws");
    await m.tasks.complete("ws", claim!.taskId, claim!.leaseToken, {
      text: "",
      toolUses: [{ ...tool, name: "jeeta_write" }],
    });
    await expect(service.run("ws", "create lead", actor)).rejects.toMatchObject(
      pending,
    );
    expect(broker.invoke).toHaveBeenCalledTimes(1);
    claim = await m.tasks.claim("ws");
    const secondPrompt = JSON.stringify(claim!.input.messages);
    await m.tasks.complete("ws", claim!.taskId, claim!.leaseToken, {
      text: "Created.",
      toolUses: [],
    });
    await expect(
      service.run("ws", "create lead", actor),
    ).resolves.toMatchObject({ answer: "Created." });
    expect(broker.invoke).toHaveBeenCalledTimes(1);
    expect(broker.invoke.mock.calls[0][0]).toMatchObject({
      userId: "alice",
      grantedScopes: ["leads.write"],
    });
    expect(m.rows).toHaveLength(2);
    expect(JSON.stringify(m.rows[1].payload.input.messages)).toBe(secondPrompt);
    await expect(
      service.run("ws", "create lead", { ...actor, id: "bob" }),
    ).rejects.toMatchObject(pending);
    expect(m.rows).toHaveLength(3);
    await expect(
      service.run("ws", "create lead", { ...actor, role: "REP" }),
    ).rejects.toMatchObject(pending);
    expect(m.rows).toHaveLength(4);
    roles.resolvePermissions.mockResolvedValue(["leads.read"]);
    await expect(service.run("ws", "create lead", actor)).rejects.toMatchObject(
      pending,
    );
    expect(m.rows).toHaveLength(5);
    expect(broker.invoke).toHaveBeenCalledTimes(1);
  });

  it("stops command retries on an ambiguous broker error before another model turn", async () => {
    const m = mailbox();
    const complete = jest.fn((o: any) => m.tasks.generate(o));
    const broker = {
      invoke: jest.fn(async () => {
        throw new Error("response lost after write");
      }),
    };
    const service = new CommandAiService(
      {
        workspace: { findUnique: async () => ({ mcpWriteMode: "AUTONOMOUS" }) },
      } as any,
      {
        isEnabledFor: async () => true,
        complete,
        runMcpToolOnce: (...args: any[]) =>
          (m.tasks as any).runToolOnce(...args),
      } as any,
      { reserveForJob: async () => 0, refund: async () => {} } as any,
      {
        listAdvertised: () => [
          {
            name: "jeeta.write",
            description: "write",
            inputSchema: z.object({}),
          },
        ],
      } as any,
      broker as any,
      { start: async () => "run", finish: async () => {} } as any,
      { resolvePermissions: async () => ["leads.write"] } as any,
    );
    const actor = { id: "alice", role: "OWNER" };
    await expect(service.run("ws", "create lead", actor)).rejects.toMatchObject(
      pending,
    );
    const claim = await m.tasks.claim("ws");
    await m.tasks.complete("ws", claim!.taskId, claim!.leaseToken, {
      text: "",
      toolUses: [{ ...tool, name: "jeeta_write" }],
    });
    for (let i = 0; i < 2; i++) {
      complete.mockClear();
      await expect(
        service.run("ws", "create lead", actor),
      ).rejects.toMatchObject({ response: { code: "AI_MCP_TOOL_UNCERTAIN" } });
      expect(complete).toHaveBeenCalledTimes(1);
    }
    expect(broker.invoke).toHaveBeenCalledTimes(1);
    expect(m.rows).toHaveLength(1);
  });

  it("propagates Ask uncertainty without converting it into model feedback", async () => {
    const uncertain = new Error("AI_MCP_TOOL_UNCERTAIN");
    const complete = jest.fn(async () => ({
      text: "",
      toolUses: [tool],
      mcpTaskId: "task-1",
    }));
    const helper = jest.fn(async () => {
      throw uncertain;
    });
    const service = new AskAiService(
      {} as any,
      {
        isEnabledFor: async () => true,
        complete,
        runMcpToolOnce: helper,
      } as any,
      { reserveForJob: async () => 0, refund: async () => {} } as any,
    );
    await expect(
      service.ask("ws", "question", { id: "alice", role: "REP" }),
    ).rejects.toBe(uncertain);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyScope: JSON.stringify(["ask", "alice", "REP"]),
      }),
    );
  });

  it("canonicalizes JSON object keys and separates actors and workspaces", async () => {
    const m = mailbox();
    await ready(m);
    const changedOrder = {
      ...opts,
      tools: [{ input_schema: { type: "object" }, name: "write" }],
    };
    await expect(m.tasks.generate(changedOrder)).resolves.toMatchObject({
      mcpTaskId: "task-1",
    });
    await expect(
      m.tasks.generate({ ...opts, idempotencyScope: "actor:b" }),
    ).rejects.toMatchObject(pending);
    await expect(
      m.tasks.generate({ ...opts, workspaceId: "other" }),
    ).rejects.toMatchObject(pending);
    expect(m.rows).toHaveLength(3);
  });

  it("refuses concurrent/in-flight tool re-execution, then replays its durable result", async () => {
    const m = mailbox();
    const res = await ready(m);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = jest.fn(async () => {
      started();
      await hold;
      return { id: "written" };
    });
    const first = (m.tasks as any).runToolOnce(
      "ws",
      res.mcpTaskId,
      tool.id,
      write,
      opts.idempotencyScope,
    );
    await entered;
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
    release();
    await first;
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).resolves.toEqual({ id: "written" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never retries a write whose outcome or result persistence is uncertain", async () => {
    const m = mailbox();
    const res = await ready(m);
    const write = jest.fn(async () => {
      throw new Error("connection lost after commit");
    });
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(["MCP_DONE", "CANCELLED"])(
    "blocks an uncertain hash beyond TTL even with status %s",
    async (status) => {
      const m = mailbox();
      const res = await ready(m);
      const write = jest.fn(async () => {
        throw new Error("lost after write");
      });
      await expect(
        m.tasks.runToolOnce(
          "ws",
          res.mcpTaskId!,
          tool.id,
          write,
          opts.idempotencyScope,
        ),
      ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
      m.rows[0].createdAt = new Date(Date.now() - 31 * 60_000);
      m.rows[0].status = status;
      await m.tasks.claim("ws");
      await expect(m.tasks.generate(opts)).rejects.toThrow(
        "AI_MCP_TOOL_UNCERTAIN",
      );
      expect(m.rows).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(1);
      await expect(
        m.tasks.generate({ ...opts, idempotencyScope: "other-actor" }),
      ).rejects.toMatchObject(pending);
    },
  );

  it("keeps a running write blocked across expiry and lets its original completion persist", async () => {
    const m = mailbox();
    const res = await ready(m);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = jest.fn(async () => {
      started();
      await hold;
      return { written: true };
    });
    const first = m.tasks.runToolOnce(
      "ws",
      res.mcpTaskId!,
      tool.id,
      write,
      opts.idempotencyScope,
    );
    await entered;
    m.rows[0].createdAt = new Date(Date.now() - 31 * 60_000);
    try {
      await m.tasks.claim("ws");
      expect(m.rows[0].status).toBe("MCP_DONE");
      await expect(m.tasks.generate(opts)).rejects.toThrow(
        "AI_MCP_TOOL_UNCERTAIN",
      );
      await expect(
        m.tasks.runToolOnce(
          "ws",
          res.mcpTaskId!,
          tool.id,
          write,
          opts.idempotencyScope,
        ),
      ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
      expect(m.rows).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    expect(m.rows[0].payload.toolExecutions[0].state).toBe("DONE");
    // Successfully completed results still have a finite replay window.
    await expect(m.tasks.generate(opts)).rejects.toMatchObject(pending);
    expect(m.rows).toHaveLength(2);
  });

  it("refuses a stale tool claim after expiry admitted a replacement", async () => {
    const m = mailbox();
    const res = await ready(m);
    m.rows[0].createdAt = new Date(Date.now() - 31 * 60_000);
    await expect(m.tasks.generate(opts)).rejects.toMatchObject(pending);
    const write = jest.fn(async () => ({ written: true }));
    await expect(
      m.tasks.runToolOnce(
        "ws",
        res.mcpTaskId!,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("expired");
    expect(write).not.toHaveBeenCalled();
    expect(m.rows).toHaveLength(2);
  });

  it("blocks replay when the write returned but saving its result failed", async () => {
    const m = mailbox();
    const res = await ready(m);
    const update = m.prisma.scheduledJob.updateMany.getMockImplementation();
    m.prisma.scheduledJob.updateMany.mockImplementation(async (args: any) => {
      if (
        args.data.payload?.toolExecutions?.some(
          (entry: any) => entry.state === "DONE",
        )
      )
        throw new Error("database lost");
      return update(args);
    });
    const write = jest.fn(async () => ({ committed: true }));
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps next-turn JSON identical when JSONB changes stored object key order", async () => {
    const m = mailbox();
    const res = await ready(m);
    const write = jest.fn(async () => ({ z: 1, nested: { b: 2, a: 1 } }));
    const first = await (m.tasks as any).runToolOnce(
      "ws",
      res.mcpTaskId,
      tool.id,
      write,
      opts.idempotencyScope,
    );
    m.rows[0].payload.toolExecutions[0].result = {
      nested: { b: 2, a: 1 },
      z: 1,
    };
    const replay = await (m.tasks as any).runToolOnce(
      "ws",
      res.mcpTaskId,
      tool.id,
      write,
      opts.idempotencyScope,
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(replay));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not run a callback when the conditional tool claim loses", async () => {
    const m = mailbox();
    const res = await ready(m);
    const write = jest.fn();
    m.prisma.scheduledJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      (m.tasks as any).runToolOnce(
        "ws",
        res.mcpTaskId,
        tool.id,
        write,
        opts.idempotencyScope,
      ),
    ).rejects.toThrow("AI_MCP_TOOL_UNCERTAIN");
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses tool replay for a different actor, workspace, or undeclared tool", async () => {
    const m = mailbox();
    const res = await ready(m);
    const write = jest.fn();
    for (const [ws, id, scope] of [
      ["other", tool.id, opts.idempotencyScope],
      ["ws", tool.id, "actor:b"],
      ["ws", "unknown", opts.idempotencyScope],
    ]) {
      await expect(
        (m.tasks as any).runToolOnce(ws, res.mcpTaskId, id, write, scope),
      ).rejects.toThrow();
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("does not permanently cancel waiting work on an unknown policy-read failure", async () => {
    const m = mailbox();
    await expect(m.tasks.generate(opts)).rejects.toMatchObject(pending);
    m.prisma.workspace.findUnique.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(m.tasks.claim("ws")).rejects.toThrow("database unavailable");
    expect(m.rows[0].status).toBe("MCP_WAITING");
    expect(await m.tasks.claim("ws")).toMatchObject({ taskId: "task-1" });
  });

  it("advertises and enforces a 24 KiB JSON response budget below the broker limit", async () => {
    const m = mailbox();
    await expect(m.tasks.generate(opts)).rejects.toMatchObject(pending);
    const claim = await m.tasks.claim("ws");
    expect(claim).toMatchObject({ maxResultBytes: 24 * 1024 });
    await expect(
      m.tasks.complete("ws", claim!.taskId, claim!.leaseToken, {
        text: "ş".repeat(13_000),
        toolUses: [],
      }),
    ).rejects.toThrow("24 KiB");
  });
});
