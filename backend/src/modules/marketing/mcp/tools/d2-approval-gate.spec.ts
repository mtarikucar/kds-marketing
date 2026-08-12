import { McpBrokerService } from '../mcp-broker.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContentTools } from './content.tools';
import { registerSocialTools } from './social.tools';

/**
 * Faz 5 D2 — the approval gate proved on the REAL tools through the REAL
 * broker, not on a synthetic fixture.
 *
 * `mcp-broker.destructive.spec.ts` pins the rule; this pins the WIRING. The two
 * fail independently and both matter: a correct rule applied to a tool that was
 * registered `risk: 'WRITE'` by a copy-paste is exactly the bug the rule exists
 * to prevent, and no unit test of either half would catch it.
 *
 * The workspace here is AUTONOMOUS — the most permissive mode the product
 * offers — and the assertion that carries the weight is that the underlying
 * SERVICE method was never called: the post still exists, the credits were
 * never reserved.
 */

const AUTONOMOUS = {
  workspaceId: 'ws1',
  grantedScopes: ['campaigns.read', 'campaigns.write', 'campaigns.send'],
  agentRunId: 'run-1',
  requireAudit: true,
  writeMode: 'AUTONOMOUS' as const,
};

function build() {
  const registry = new McpToolRegistry();
  const social = {
    listPosts: jest.fn().mockResolvedValue([]),
    createPost: jest.fn().mockResolvedValue({ id: 'p1' }),
    publishNow: jest.fn().mockResolvedValue({ id: 'p1' }),
    getPost: jest.fn().mockResolvedValue({ id: 'p1' }),
    updatePost: jest.fn().mockResolvedValue({ id: 'p1' }),
    deletePost: jest.fn().mockResolvedValue({ deleted: true }),
    schedulePost: jest.fn().mockResolvedValue({ id: 'p1' }),
    listAccounts: jest.fn().mockResolvedValue([]),
  };
  const media = {
    requestGeneration: jest.fn().mockResolvedValue({ assetId: 'as1' }),
    listAssets: jest.fn().mockResolvedValue([]),
  };
  registerSocialTools(registry, { social: social as never });
  registerContentTools(registry, {
    calendar: { range: jest.fn().mockResolvedValue([]) } as never,
    media: media as never,
    principals: { resolve: jest.fn().mockResolvedValue({ id: 'sys-1' }) } as never,
    entitlements: {
      getEffective: jest.fn().mockResolvedValue({ features: { mediaGen: true, socialCampaigns: true } }),
    } as never,
  });
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const broker = new McpBrokerService(
    registry,
    { enqueue, supersedePending } as never,
    { recordTool: jest.fn() } as never,
  );
  return { broker, social, media, enqueue };
}

describe('Faz 5 D2 — DESTRUCTIVE stays gated in AUTONOMOUS; SPEND queues only in APPROVAL', () => {
  it('jeeta.delete_social_post is QUEUED under AUTONOMOUS — the post is not deleted', async () => {
    const { broker, social, enqueue } = build();
    const res = await broker.invoke(AUTONOMOUS, 'jeeta.delete_social_post', { postId: 'p1' });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(social.deletePost).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ kind: 'DESTRUCTIVE', payload: { tool: 'jeeta.delete_social_post', args: { postId: 'p1' } } }),
    );
  });

  it.each(['jeeta.generate_image', 'jeeta.generate_video'])(
    '%s is QUEUED under APPROVAL — no credits are reserved',
    async (tool) => {
      const { broker, media, enqueue } = build();
      const res = await broker.invoke({ ...AUTONOMOUS, writeMode: 'APPROVAL' as const }, tool, { prompt: 'a plate of manti' });
      expect(res.status).toBe('PENDING_APPROVAL');
      expect(media.requestGeneration).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'MEDIA_SPEND' }));
    },
  );

  it.each(['jeeta.generate_image', 'jeeta.generate_video'])(
    '%s runs INLINE under AUTONOMOUS — spend is bounded by workspace balances (owner decision, 2026-08-12)',
    async (tool) => {
      const { broker, media, enqueue } = build();
      const res = await broker.invoke(AUTONOMOUS, tool, { prompt: 'a plate of manti' });
      expect(res.status).toBe('OK');
      expect(media.requestGeneration).toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('the delete DOES run once a human approved it (the gate is a queue, not a wall)', async () => {
    const { broker, social } = build();
    const res = await broker.invoke(
      { ...AUTONOMOUS, approvedBy: { approvalId: 'appr-1', userId: 'u1' } },
      'jeeta.delete_social_post',
      { postId: 'p1' },
    );
    expect(res).toEqual({ status: 'OK', result: { deleted: true } });
    expect(social.deletePost).toHaveBeenCalledWith('ws1', 'p1');
  });

  it('jeeta.schedule_social_post keeps the AUTONOMOUS bypass (PUBLISH, not SPEND) but is gated in APPROVAL mode', async () => {
    // Scheduling is PUBLISH-class: an autonomous workspace has explicitly opted
    // into unattended publishing, and a wrong post is visible and deletable.
    // The default (APPROVAL) mode must still queue it.
    const auto = build();
    await auto.broker.invoke(AUTONOMOUS, 'jeeta.schedule_social_post', {
      postId: 'p1',
      scheduledAt: '2026-08-05T09:30:00.000Z',
    });
    expect(auto.social.schedulePost).toHaveBeenCalled();

    const approval = build();
    const res = await approval.broker.invoke(
      { ...AUTONOMOUS, writeMode: 'APPROVAL' as never },
      'jeeta.schedule_social_post',
      { postId: 'p1', scheduledAt: '2026-08-05T09:30:00.000Z' },
    );
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(approval.social.schedulePost).not.toHaveBeenCalled();
  });

  it('leaves the ungated D2 reads and drafts running inline in both modes', async () => {
    for (const writeMode of ['APPROVAL', 'AUTONOMOUS'] as const) {
      const { broker, social } = build();
      const res = await broker.invoke({ ...AUTONOMOUS, writeMode }, 'jeeta.update_social_post', {
        postId: 'p1',
        content: 'edit',
      });
      expect(res.status).toBe('OK');
      expect(social.updatePost).toHaveBeenCalled();
    }
  });
});
