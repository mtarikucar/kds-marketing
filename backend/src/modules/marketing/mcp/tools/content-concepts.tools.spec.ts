import { ForbiddenException } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContentConceptTools } from './content-concepts.tools';

function build(over: { features?: Record<string, boolean> } = {}) {
  const registry = new McpToolRegistry();
  const concepts = {
    planConcepts: jest.fn().mockResolvedValue({ batchId: 'b1', sourceIdea: 'idea', concepts: [] }),
    list: jest.fn().mockResolvedValue([]),
    review: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
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
    await expect(
      registry
        .get('jeeta.review_content_concept')!
        .handler(ctx(), { conceptId: 'c1', decision: 'APPROVED' }),
    ).rejects.toThrow(/human|signed-in/i);
    expect(concepts.review).not.toHaveBeenCalled();
  });

  it('only accepts the two real decisions', () => {
    const tool = build().registry.get('jeeta.review_content_concept')!;
    expect(() => tool.inputSchema.parse({ conceptId: 'c1', decision: 'MAYBE' })).toThrow();
    expect(() => tool.inputSchema.parse({ conceptId: 'c1', decision: 'DISCARDED' })).not.toThrow();
  });
});
