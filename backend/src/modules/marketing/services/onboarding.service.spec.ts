import { OnboardingService } from './onboarding.service';

const WS = 'ws-1';

function makeSvc(settings: unknown) {
  const prisma = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ settings, mcpWriteMode: 'AUTONOMOUS' }),
      update: jest.fn().mockResolvedValue({}),
    },
    // The "connect your Claude" step's completion signal. Absent here: these
    // cases are about the dismissal flag, and the lane has its own describe.
    agentRun: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  return { svc: new OnboardingService(prisma), prisma };
}

describe('OnboardingService', () => {
  it('reads dismissed=false for a workspace that has never dismissed', async () => {
    const { svc } = makeSvc(null);
    expect(await svc.get(WS)).toMatchObject({ dismissed: false });
  });

  it('reads the stored flag', async () => {
    const { svc } = makeSvc({ onboarding: { dismissed: true } });
    expect(await svc.get(WS)).toMatchObject({ dismissed: true });
  });

  /**
   * `settings` is a shared free-shape bag (businessTypes and whatever else has
   * been parked there). Writing the onboarding flag must MERGE — replacing the
   * object would silently wipe unrelated workspace configuration, and nothing
   * in the schema would complain.
   */
  it('preserves the rest of settings when writing the flag', async () => {
    const { svc, prisma } = makeSvc({
      businessTypes: ['restaurant'],
      somethingElse: { a: 1 },
      onboarding: { dismissed: false, other: 'keep me' },
    });

    await svc.setDismissed(WS, true);

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: {
        settings: {
          businessTypes: ['restaurant'],
          somethingElse: { a: 1 },
          onboarding: { dismissed: true, other: 'keep me' },
        },
      },
    });
  });

  it('creates the settings bag when the workspace has none', async () => {
    const { svc, prisma } = makeSvc(null);
    await svc.setDismissed(WS, true);
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: { settings: { onboarding: { dismissed: true } } },
    });
  });

  it('can un-dismiss (the header\'s "show setup guide" path)', async () => {
    const { svc, prisma } = makeSvc({ onboarding: { dismissed: true } });
    expect(await svc.setDismissed(WS, false)).toEqual({ dismissed: false });
    expect(prisma.workspace.update.mock.calls[0][0].data.settings).toEqual({
      onboarding: { dismissed: false },
    });
  });

  it('treats a non-object settings value as empty rather than throwing', async () => {
    const { svc } = makeSvc('corrupt');
    expect(await svc.get(WS)).toMatchObject({ dismissed: false });
  });
});

/**
 * The fourth setup step: "connect your Claude".
 *
 * Its completion signal is the whole design. "An API key exists" is intent —
 * the exact half-finished setup this feature dies of, because a key with no
 * scheduled task behind it looks identical to a working lane. The only proof
 * that the lane WORKS is that something actually leased a research job, and
 * `ResearchLeaseService.claim()` opens exactly one `research.mcp` AgentRun per
 * successful claim.
 */
describe('OnboardingService — proving the Claude lane', () => {
  function makeSvc2(over: { runs?: unknown; writeMode?: string | null } = {}) {
    const seen: any[] = [];
    const prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          settings: null,
          mcpWriteMode: over.writeMode === undefined ? 'AUTONOMOUS' : over.writeMode,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      agentRun: {
        findFirst: jest.fn(async (args: any) => {
          seen.push(args.where);
          return over.runs ?? null;
        }),
      },
    } as any;
    return { svc: new OnboardingService(prisma), prisma, seen };
  }

  it('is NOT proven by a key, only by a real claim', async () => {
    const { svc } = makeSvc2({ runs: null });
    expect(await svc.get(WS)).toMatchObject({ claudeLaneProven: false });
  });

  it('is proven the first time a research job was actually leased', async () => {
    const { svc } = makeSvc2({ runs: { id: 'ar-1' } });
    expect(await svc.get(WS)).toMatchObject({ claudeLaneProven: true });
  });

  /**
   * The `agent` filter is what makes this "a CLAIM" rather than "any agent ran".
   * Without it the platform's own nightly research — which opens `research`
   * runs on every SERVER workspace — would tick the step for a customer who
   * never connected anything.
   */
  it('looks only at THIS workspace and only at MCP-leased research runs', async () => {
    const { svc, seen } = makeSvc2();
    await svc.get(WS);
    expect(seen[0]).toEqual({ workspaceId: WS, agent: 'research.mcp' });
  });

  it('never reads another workspace runs', async () => {
    const { svc, seen } = makeSvc2();
    await svc.get('ws-elsewhere');
    expect(seen[0].workspaceId).toBe('ws-elsewhere');
  });

  /**
   * The warning the step has to carry, and only when it applies. Measured in
   * v2.286.0: under APPROVAL the three Jeeta-keyed data tools do not merely
   * queue, they are UNUSABLE — the approval executor returns the result to the
   * approver's HTTP response, never to the agent's turn — so the lane silently
   * loses the Google Maps pain signal it was designed around.
   */
  it('reports the write mode so the step can warn about APPROVAL', async () => {
    const gated = makeSvc2({ writeMode: 'APPROVAL' });
    expect(await gated.svc.get(WS)).toMatchObject({ mcpWriteMode: 'APPROVAL' });

    const open = makeSvc2({ writeMode: 'AUTONOMOUS' });
    expect(await open.svc.get(WS)).toMatchObject({ mcpWriteMode: 'AUTONOMOUS' });
  });

  it('fails safe to APPROVAL on an unset mode, so the warning is not lost', async () => {
    const { svc } = makeSvc2({ writeMode: null });
    expect(await svc.get(WS)).toMatchObject({ mcpWriteMode: 'APPROVAL' });
  });
});
