import { McpToolRegistry } from '../mcp-tool-registry';
import { registerReviewTools, type ReviewToolDeps } from './reviews.tools';

const WS = 'ws-1';
const ctx = { workspaceId: WS, grantedScopes: [] as string[] };

function build(features: Record<string, boolean> = { reviews: true }) {
  const deps = {
    reviews: {
      list: jest.fn(async () => [{ id: 'r1' }]),
      saveReply: jest.fn(async () => ({ id: 'r1', status: 'REPLIED' })),
    },
    entitlements: { getEffective: jest.fn(async () => ({ features })) },
  };
  const registry = new McpToolRegistry();
  registerReviewTools(registry, deps as unknown as ReviewToolDeps);
  return { registry, deps };
}

describe('reviews tools', () => {
  it('registers exactly the two review tools in the reviews domain', () => {
    const { registry } = build();
    const tools = registry.list(['settings.manage']);
    expect(tools.map((t) => t.name).sort()).toEqual(['jeeta.list_reviews', 'jeeta.reply_to_review']);
    for (const t of tools) {
      expect(t.domain).toBe('reviews');
      // MarketingReviewsController is MANAGER + @RequiresFeature('reviews'),
      // and its reply route is @RequirePermission('settings.manage').
      expect(t.scopes).toEqual(['settings.manage']);
    }
  });

  it('advertises the read and defers the reply', () => {
    const { registry } = build();
    expect(registry.get('jeeta.list_reviews')!.defer).toBeFalsy();
    expect(registry.get('jeeta.reply_to_review')!.defer).toBe(true);
  });

  it('jeeta.list_reviews reads the caller workspace', async () => {
    const { registry, deps } = build();
    await expect(registry.get('jeeta.list_reviews')!.handler(ctx, {})).resolves.toEqual([{ id: 'r1' }]);
    expect(deps.reviews.list).toHaveBeenCalledWith(WS);
  });
});

/**
 * ## The finding: replying does NOT post publicly
 *
 * The wave was scoped on the assumption that `reply_to_review` speaks in public
 * under the business's name. Read against the code, that is not what happens
 * today. `ReviewsService.saveReply`'s whole body is a workspace-scoped lookup
 * and `prisma.review.update({ replyText, status: 'REPLIED' })`. There is no
 * Google Business Profile reply call anywhere in the repo — `review-clients.ts`
 * only ever GETs (`mybusiness.googleapis.com/v4/.../reviews`, and the Facebook
 * page ratings feed); the `business.manage` OAuth scope is requested but never
 * used for a write. The panel's button says "Save reply".
 *
 * So the words stay inside Jeeta until a human pastes them into Google.
 *
 * ## And it is gated anyway
 *
 * Two reasons, neither of them "the name sounds scary":
 *
 *  1. **The text IS the brand's public voice, one copy-paste from publication.**
 *     The entire purpose of the field is to be posted verbatim under the
 *     business's name. An agent apologising, admitting fault or promising a
 *     refund on a one-star review is a statement the business will be held to.
 *  2. **The status flip retires the review from the human queue.** Marking a
 *     complaint `REPLIED` when nobody has actually answered it in public is
 *     worse than doing nothing: it hides the review from the team that would
 *     have handled it.
 *
 * `PUBLISH`, not `SEND`: nothing is delivered to an individual — this is
 * speech aimed at an audience, the same shape as `publish_social_post`.
 */
describe('jeeta.reply_to_review', () => {
  it('is approval-gated as PUBLISH, superseded per review', () => {
    const { registry } = build();
    const tool = registry.get('jeeta.reply_to_review')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('PUBLISH');
    expect(tool.resourceType).toBe('review');
    expect(tool.resourceIdFrom!({ reviewId: 'r7' })).toBe('r7');
  });

  /**
   * Honesty in the description is load-bearing here: a model that believes it
   * posted to Google will TELL the user it posted to Google, and the user will
   * not go and paste it.
   */
  it('tells the caller the reply is not published to Google/Facebook by Jeeta', () => {
    const { registry } = build();
    const description = registry.get('jeeta.reply_to_review')!.description;
    expect(description).toMatch(/does not|not automatically/i);
    expect(description).toMatch(/google/i);
  });

  it('saves the reply against the review in the caller workspace', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.reply_to_review')!.handler(ctx, { reviewId: 'r1', text: 'Thank you!' });
    expect(deps.reviews.saveReply).toHaveBeenCalledWith(WS, 'r1', 'Thank you!');
  });

  it('bounds the reply at the length the REST DTO allows', () => {
    const { registry } = build();
    const schema = registry.get('jeeta.reply_to_review')!.inputSchema;
    expect(schema.safeParse({ reviewId: 'r1', text: '' }).success).toBe(false);
    expect(schema.safeParse({ reviewId: 'r1', text: 'x'.repeat(4001) }).success).toBe(false);
    expect(schema.safeParse({ reviewId: 'r1', text: 'x'.repeat(4000) }).success).toBe(true);
  });

  /**
   * `ReviewsService.draftReply` reserves AI credits and calls Anthropic. It is
   * not exposed: an MCP caller IS a model and can write the reply itself, so
   * the tool would spend the workspace's credits to produce something the
   * caller already has.
   */
  it('exposes no AI-draft tool that would spend credits to do the caller\'s own job', () => {
    const { registry } = build();
    expect(registry.has('jeeta.draft_review_reply')).toBe(false);
  });
});

describe('reviews feature gate', () => {
  it.each([
    ['jeeta.list_reviews', {}],
    ['jeeta.reply_to_review', { reviewId: 'r1', text: 'hi' }],
  ])('%s refuses cleanly without the reviews feature', async (name, args) => {
    const { registry, deps } = build({});
    await expect(registry.get(name)!.handler(ctx, args)).rejects.toMatchObject({
      response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'reviews' },
    });
    expect(deps.reviews.list).not.toHaveBeenCalled();
    expect(deps.reviews.saveReply).not.toHaveBeenCalled();
  });
});
