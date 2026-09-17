import { McpToolRegistry } from "../mcp-tool-registry";
import { registerAiInferenceTools } from "./ai-inference.tools";

describe("MCP inference queue authorization", () => {
  function setup() {
    const registry = new McpToolRegistry();
    const tasks = {
      claim: jest.fn().mockResolvedValue(null),
      complete: jest.fn().mockResolvedValue({ completed: true }),
    };
    registerAiInferenceTools(registry, tasks as any);
    return { registry, tasks };
  }
  it("rejects a demoted OAuth user even when an old token still carries settings.manage", async () => {
    const { registry, tasks } = setup();
    const ctx = {
      workspaceId: "ws",
      userId: "member",
      userRole: "REP",
      grantedScopes: ["settings.manage"],
    } as any;
    await expect(
      registry.get("jeeta.claim_ai_task")!.handler(ctx, {}),
    ).rejects.toThrow();
    await expect(
      registry
        .get("jeeta.complete_ai_task")!
        .handler(ctx, {
          taskId: "job",
          leaseToken: "lease",
          text: "x",
          toolUses: [],
        }),
    ).rejects.toThrow();
    expect(tasks.claim).not.toHaveBeenCalled();
    expect(tasks.complete).not.toHaveBeenCalled();
  });
  it("retains explicitly delegated workspace keys and active managers", async () => {
    const { registry, tasks } = setup();
    await registry
      .get("jeeta.claim_ai_task")!
      .handler({ workspaceId: "ws" } as any, {});
    await registry
      .get("jeeta.claim_ai_task")!
      .handler(
        { workspaceId: "ws", userId: "member", userRole: "MANAGER" } as any,
        {},
      );
    expect(tasks.claim).toHaveBeenCalledTimes(2);
    expect(registry.get("jeeta.claim_ai_task")!.scopes).toEqual([
      "settings.manage",
    ]);
  });
});
