import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { McpBrokerService } from '../mcp-broker.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContentConceptTools } from './content-concepts.tools';

function build(over: { features?: Record<string, boolean> } = {}) {
  const registry = new McpToolRegistry();
  const concepts = {
    planConcepts: jest.fn().mockResolvedValue({ batchId: 'b1', sourceIdea: 'idea', concepts: [] }),
    list: jest.fn().mockResolvedValue([]),
    review: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
    produce: jest.fn().mockResolvedValue({ conceptId: 'c1', itemId: 'i1', created: true }),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue({ id: 'sys-1', workspaceId: 'ws1', role: 'SYSTEM' }),
    assertActiveMember: jest.fn(),
  };
  const entitlements = {
    getEffective: jest.fn().mockResolvedValue({ features: over.features ?? { socialCampaigns: true } }),
  };
  registerContentConceptTools(registry, {
    concepts: concepts as never,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, concepts, principals, entitlements };
}

const ctx = (extra: Record<string, unknown> = {}) => ({
  workspaceId: 'ws1',
  grantedScopes: [],
  ...extra,
});

describe('jeeta.plan_content_concepts', () => {
  it('declares the fields the broker reads: ungated, campaigns.write, content', () => {
    const tool = build().registry.get('jeeta.plan_content_concepts')!;
    // `requiresApproval: false` is the load-bearing one — it is the field
    // McpBrokerService.invoke actually branches on. `risk` is inert except as
    // an input to ALWAYS_APPROVED_RISKS (which holds DESTRUCTIVE and nothing
    // else) and as a label find_tools prints, so WRITE here is a description,
    // not a gate: relabelling this tool SPEND would not queue it, and
    // jeeta.synthesize_strategy / jeeta.run_research are SPEND tools queued by
    // their own requiresApproval flag. What the flag being false buys is
    // measured behaviourally below ('the broker runs it inline in APPROVAL
    // mode'); the assertions here only pin the declaration.
    expect(tool.requiresApproval).toBe(false);
    expect(tool.risk).toBe('WRITE');
    expect(tool.scopes).toEqual(['campaigns.write']);
    expect(tool.domain).toBe('content');
  });

  it('says in its own description that it spends AI credits', () => {
    // Not SPEND-classified is not the same as free. The model is told.
    expect(build().registry.get('jeeta.plan_content_concepts')!.description).toMatch(/credit/i);
  });

  it('forwards the idea, the count and the campaign scope, with a real actor', async () => {
    const { registry, concepts, principals } = build();
    await registry.get('jeeta.plan_content_concepts')!.handler(ctx(), {
      idea: 'Strandbeest',
      count: 5,
      socialCampaignId: 'sc1',
      videoModel: 'veo',
    });
    expect(principals.resolve).toHaveBeenCalled();
    expect(concepts.planConcepts).toHaveBeenCalledWith('ws1', {
      idea: 'Strandbeest',
      count: 5,
      socialCampaignId: 'sc1',
      videoModel: 'veo',
      createdById: 'sys-1',
    });
  });

  it('prefers the signed-in human over the service sentinel as the author', async () => {
    const { registry, concepts } = build();
    await registry
      .get('jeeta.plan_content_concepts')!
      .handler(ctx({ userId: 'u9' }), { idea: 'Strandbeest' });
    expect(concepts.planConcepts.mock.calls[0][1].createdById).toBe('u9');
  });

  it('is refused by a workspace whose package does not include socialCampaigns', async () => {
    const { registry, concepts } = build({ features: { socialCampaigns: false } });
    await expect(
      registry.get('jeeta.plan_content_concepts')!.handler(ctx(), { idea: 'x' }),
    ).rejects.toThrow(ForbiddenException);
    // The gate runs FIRST — before the actor is resolved and long before an
    // Anthropic call could be paid for.
    expect(concepts.planConcepts).not.toHaveBeenCalled();
  });
});

describe('jeeta.plan_content_concepts through the real broker', () => {
  /**
   * The premise of the whole classification, asserted as BEHAVIOUR.
   *
   * The design says: this tool must be usable from the chat, and the chat runs
   * in a workspace's default `APPROVAL` write mode. Everything else — the
   * docblock, the `requiresApproval: false`, the note about the approval
   * executor answering the approver instead of the agent — is downstream of
   * that one sentence. Before this test, flipping `requiresApproval` to `true`
   * made the feature unreachable from its only surface and only a literal
   * restatement of the field noticed.
   */
  const withBroker = () => {
    const built = build();
    const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
    const supersedePending = jest.fn().mockResolvedValue(undefined);
    const recordTool = jest.fn().mockResolvedValue(undefined);
    const broker = new McpBrokerService(
      built.registry,
      { enqueue, supersedePending } as never,
      { recordTool } as never,
    );
    return { ...built, broker, enqueue };
  };

  const brokerCtx = {
    workspaceId: 'ws1',
    grantedScopes: ['campaigns.write'],
    agentRunId: 'run-1',
    requireAudit: true,
    writeMode: 'APPROVAL' as const,
  };

  it('RUNS INLINE in APPROVAL mode and hands the concepts back to the caller', async () => {
    const { broker, concepts, enqueue } = withBroker();

    const res = await broker.invoke(brokerCtx, 'jeeta.plan_content_concepts', {
      idea: 'Strandbeest',
    });

    // OK, not PENDING_APPROVAL: the agent turn that asked receives the batch.
    expect(res.status).toBe('OK');
    expect(res.result).toEqual({ batchId: 'b1', sourceIdea: 'idea', concepts: [] });
    expect(concepts.planConcepts).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('and the same broker, same mode, DOES queue a gated tool', async () => {
    // The control. Without it, the assertion above could pass because this
    // broker/ctx gates nothing at all rather than because the tool is ungated.
    const { registry, broker, enqueue } = withBroker();
    const gatedHandler = jest.fn();
    registry.register({
      name: 'jeeta.control_gated',
      description: 'a gated control tool',
      domain: 'content',
      scopes: ['campaigns.write'],
      risk: 'WRITE',
      requiresApproval: true,
      inputSchema: z.object({}),
      handler: gatedHandler,
    });

    const res = await broker.invoke(brokerCtx, 'jeeta.control_gated', {});

    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
    expect(gatedHandler).not.toHaveBeenCalled();
  });
});

describe('jeeta.list_content_concepts', () => {
  it('is a plain read', () => {
    const tool = build().registry.get('jeeta.list_content_concepts')!;
    expect(tool.risk).toBe('READ');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['campaigns.read']);
  });

  it('passes the status and batch filters through', async () => {
    const { registry, concepts } = build();
    await registry
      .get('jeeta.list_content_concepts')!
      .handler(ctx(), { status: 'PROPOSED', batchId: 'b1' });
    expect(concepts.list).toHaveBeenCalledWith('ws1', { status: 'PROPOSED', batchId: 'b1' });
  });
});

describe('jeeta.review_content_concept', () => {
  it('records the decision under the SIGNED-IN human', async () => {
    const { registry, concepts } = build();
    await registry
      .get('jeeta.review_content_concept')!
      .handler(ctx({ userId: 'u9' }), { conceptId: 'c1', decision: 'APPROVED', note: 'bu güzelmiş' });
    expect(concepts.review).toHaveBeenCalledWith('ws1', 'c1', {
      decision: 'APPROVED',
      reviewerId: 'u9',
      note: 'bu güzelmiş',
    });
  });

  it('REFUSES a session with no human behind it', async () => {
    // An API-key session belongs to a workspace, not a person. Letting it
    // approve would mean an unattended agent signing off its own concepts,
    // which is the review being deleted rather than performed. Unlike every
    // other write tool here, this one does NOT fall back to the service
    // principal — there is no honest value to put in `reviewedById`.
    const { registry, concepts } = build();
    const call = () =>
      registry
        .get('jeeta.review_content_concept')!
        .handler(ctx(), { conceptId: 'c1', decision: 'APPROVED' });
    // The 403 itself, not just the wording — a refusal that changed class (to a
    // 400, say) would still match the message and would still be a different
    // answer to the caller.
    await expect(call()).rejects.toThrow(ForbiddenException);
    await expect(call()).rejects.toThrow(/human|signed-in/i);
    expect(concepts.review).not.toHaveBeenCalled();
  });

  it('only accepts the two real decisions', () => {
    const tool = build().registry.get('jeeta.review_content_concept')!;
    expect(() => tool.inputSchema.parse({ conceptId: 'c1', decision: 'MAYBE' })).toThrow();
    expect(() => tool.inputSchema.parse({ conceptId: 'c1', decision: 'DISCARDED' })).not.toThrow();
  });

  it('forwards the campaign an approval names, so an unscoped idea can still be produced', async () => {
    // Approving is what starts production, and production needs a calendar,
    // target accounts and a model choice — all of which live on the campaign.
    // A concept pasted into the chat has none, so the reviewer supplies one.
    const { registry, concepts } = build();
    await registry
      .get('jeeta.review_content_concept')!
      .handler(ctx({ userId: 'u9' }), {
        conceptId: 'c1',
        decision: 'APPROVED',
        socialCampaignId: 'camp-7',
      });
    expect(concepts.review).toHaveBeenCalledWith('ws1', 'c1', {
      decision: 'APPROVED',
      reviewerId: 'u9',
      socialCampaignId: 'camp-7',
    });
  });
});

/**
 * Blocker 2's second caller, at the tool boundary.
 *
 * `promote()` had exactly one caller — `review()` — and `review()` refuses a
 * concept it has already decided. So an APPROVED concept whose item never got
 * made had no route back from ANY surface: no controller, no route, no tool.
 * This is the route.
 */
describe('jeeta.produce_content_concept', () => {
  it('is declared like its siblings: deferred, campaigns.write, content, ungated', () => {
    const tool = build().registry.get('jeeta.produce_content_concept')!;
    expect(tool.defer).toBe(true);
    expect(tool.scopes).toEqual(['campaigns.write']);
    expect(tool.domain).toBe('content');
    expect(tool.requiresApproval).toBe(false);
  });

  it('says both that it is safe to repeat and that it can spend', () => {
    // Either half alone is a lie. "Idempotent" without the spend hides that a
    // never-produced concept buys a clip per beat; "spends" without the
    // idempotency discourages the very repair it exists to perform.
    const d = build().registry.get('jeeta.produce_content_concept')!.description;
    expect(d).toMatch(/repeatedly|idempotent/i);
    expect(d).toMatch(/spend/i);
    expect(d).toMatch(/resume|already own|already paid/i);
  });

  it('forwards the concept and the optional campaign, workspace-scoped', async () => {
    const { registry, concepts } = build();
    await registry.get('jeeta.produce_content_concept')!.handler(ctx(), {
      conceptId: 'c1',
      socialCampaignId: 'camp-9',
    });
    expect(concepts.produce).toHaveBeenCalledWith('ws1', 'c1', { socialCampaignId: 'camp-9' });
  });

  it('omits the campaign entirely when none was named, rather than passing undefined', async () => {
    const { registry, concepts } = build();
    await registry.get('jeeta.produce_content_concept')!.handler(ctx(), { conceptId: 'c1' });
    expect(concepts.produce).toHaveBeenCalledWith('ws1', 'c1', {});
  });

  it('needs no signed-in human — it acts on a decision a human already made', async () => {
    // The opposite of review_content_concept, deliberately: there is no
    // reviewer field to fill in dishonestly here, and refusing an unattended
    // session would make the repair unreachable from the only lane an agent
    // notices the problem in.
    const { registry, concepts } = build();
    await expect(
      registry.get('jeeta.produce_content_concept')!.handler(ctx(), { conceptId: 'c1' }),
    ).resolves.toBeTruthy();
    expect(concepts.produce).toHaveBeenCalled();
  });

  it('is gated on the socialCampaigns package feature like the rest', async () => {
    const { registry, concepts } = build({ features: { socialCampaigns: false } });
    await expect(
      registry.get('jeeta.produce_content_concept')!.handler(ctx(), { conceptId: 'c1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(concepts.produce).not.toHaveBeenCalled();
  });
});
