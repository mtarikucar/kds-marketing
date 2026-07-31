import { McpToolRegistry } from '../mcp-tool-registry';
import { registerSocialTools } from './social.tools';

const social = () => ({
  listPosts: jest.fn().mockResolvedValue([]),
  createPost: jest.fn(),
  publishNow: jest.fn(),
  getPost: jest.fn().mockResolvedValue({ id: 'p1' }),
  updatePost: jest.fn().mockResolvedValue({ id: 'p1' }),
  deletePost: jest.fn().mockResolvedValue({ deleted: true }),
  schedulePost: jest.fn().mockResolvedValue({ id: 'p1', status: 'SCHEDULED' }),
  listAccounts: jest.fn().mockResolvedValue([]),
  networkStatus: jest.fn().mockResolvedValue({}),
});

function build(overrides: Partial<ReturnType<typeof social>> = {}) {
  const registry = new McpToolRegistry();
  const deps = { social: { ...social(), ...overrides } as never };
  registerSocialTools(registry, deps);
  return { registry, social: deps.social as unknown as ReturnType<typeof social> };
}

const ctx = (scopes: string[] = []) => ({ workspaceId: 'ws1', grantedScopes: scopes });

describe('Faz 5 D2 — connected social accounts', () => {
  it('registers jeeta.list_social_accounts as a plain read', () => {
    const { registry } = build();
    const tool = registry.get('jeeta.list_social_accounts')!;
    expect(tool.risk).toBe('READ');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['campaigns.read']);
  });

  it('returns the network + handle + health of each connected account', async () => {
    const { registry, social } = build({
      listAccounts: jest.fn().mockResolvedValue([
        {
          id: 'a1',
          network: 'INSTAGRAM',
          externalId: 'ig-123',
          displayName: '@jeetagrowth',
          accountType: 'IG_BUSINESS',
          connectedVia: 'OAUTH',
          enabled: true,
          lastError: null,
          tokenExpiresAt: new Date('2099-01-01'),
          createdAt: new Date('2026-01-01'),
        },
      ]),
    });
    const out = (await registry
      .get('jeeta.list_social_accounts')!
      .handler(ctx(['campaigns.read']), {})) as Array<Record<string, unknown>>;
    expect(social.listAccounts).toHaveBeenCalledWith('ws1');
    expect(out[0]).toEqual(
      expect.objectContaining({
        id: 'a1',
        network: 'INSTAGRAM',
        displayName: '@jeetagrowth',
        enabled: true,
        needsReconnect: false,
      }),
    );
  });

  it('NEVER leaks token material, not even the masked form the REST DTO returns', async () => {
    // SocialPlannerService.listAccounts already masks accessToken/refreshToken,
    // but a masked secret is still secret-shaped material sitting in a model's
    // context window (and in the ToolCallLog result column). The tool projects
    // to an explicit allow-list instead of spreading the row.
    const { registry } = build({
      listAccounts: jest.fn().mockResolvedValue([
        {
          id: 'a1',
          network: 'TIKTOK',
          externalId: 'tt-1',
          displayName: 'jeeta',
          enabled: true,
          accessToken: '****abcd',
          refreshToken: '****wxyz',
          tokenExpiresAt: null,
          createdAt: new Date(),
        },
      ]),
    });
    const out = await registry.get('jeeta.list_social_accounts')!.handler(ctx(['campaigns.read']), {});
    const json = JSON.stringify(out);
    expect(json).not.toContain('abcd');
    expect(json).not.toContain('wxyz');
    expect(json).not.toContain('accessToken');
    expect(json).not.toContain('refreshToken');
  });

  it('flags an account whose token expired or errored as needing a reconnect', async () => {
    const { registry } = build({
      listAccounts: jest.fn().mockResolvedValue([
        { id: 'a1', network: 'FACEBOOK', displayName: 'p', enabled: true, tokenExpiresAt: new Date('2000-01-01') },
        { id: 'a2', network: 'LINKEDIN', displayName: 'l', enabled: true, lastError: 'reauth_required', tokenExpiresAt: null },
        { id: 'a3', network: 'TIKTOK', displayName: 't', enabled: false, tokenExpiresAt: null },
      ]),
    });
    const out = (await registry
      .get('jeeta.list_social_accounts')!
      .handler(ctx(['campaigns.read']), {})) as Array<{ needsReconnect: boolean }>;
    expect(out.map((a) => a.needsReconnect)).toEqual([true, true, true]);
  });
});

describe('Faz 5 D2 — social post read/write/schedule/delete', () => {
  it('jeeta.get_social_post reads one post', async () => {
    const { registry, social } = build();
    const tool = registry.get('jeeta.get_social_post')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['campaigns.read']);
    await tool.handler(ctx(['campaigns.read']), { postId: 'p1' });
    expect(social.getPost).toHaveBeenCalledWith('ws1', 'p1');
  });

  it('jeeta.update_social_post is an ungated WRITE that forwards the patch', async () => {
    const { registry, social } = build();
    const tool = registry.get('jeeta.update_social_post')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['campaigns.write']);
    await tool.handler(ctx(['campaigns.write']), {
      postId: 'p1',
      content: 'new copy',
      mediaUrls: ['https://x/a.jpg'],
      targetAccountIds: ['a1'],
    });
    expect(social.updatePost).toHaveBeenCalledWith('ws1', 'p1', {
      content: 'new copy',
      mediaUrls: ['https://x/a.jpg'],
      targetAccountIds: ['a1'],
    });
  });

  it('jeeta.update_social_post omits absent fields so an unmentioned field is not cleared', async () => {
    const { registry, social } = build();
    await registry
      .get('jeeta.update_social_post')!
      .handler(ctx(['campaigns.write']), { postId: 'p1', content: 'only copy' });
    expect(social.updatePost).toHaveBeenCalledWith('ws1', 'p1', { content: 'only copy' });
  });

  describe('jeeta.schedule_social_post', () => {
    it('is PUBLISH-gated — scheduling is publishing with a delay', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.schedule_social_post')!;
      // The post goes out to a real audience without a further human touch, so
      // it carries the same gate as publish_social_post. Down-ranking it to
      // WRITE because "nothing happens right now" would make the delay itself
      // the loophole.
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('PUBLISH');
      expect(tool.scopes).toEqual(['campaigns.send']);
      expect(tool.resourceType).toBe('social_post');
      expect(tool.resourceIdFrom!({ postId: 'p9' })).toBe('p9');
    });

    it('forwards a parsed Date plus optional targets/formats', async () => {
      const { registry, social } = build();
      await registry.get('jeeta.schedule_social_post')!.handler(ctx(['campaigns.send']), {
        postId: 'p1',
        scheduledAt: '2026-08-05T09:30:00.000Z',
        targetAccountIds: ['a1', 'a2'],
        formats: { a1: 'REEL' },
      });
      expect(social.schedulePost).toHaveBeenCalledWith(
        'ws1',
        'p1',
        new Date('2026-08-05T09:30:00.000Z'),
        ['a1', 'a2'],
        { a1: 'REEL' },
      );
    });

    it('refuses an unparseable scheduledAt rather than scheduling at the epoch', async () => {
      const { registry, social } = build();
      await expect(
        registry
          .get('jeeta.schedule_social_post')!
          .handler(ctx(['campaigns.send']), { postId: 'p1', scheduledAt: 'next tuesday' }),
      ).rejects.toThrow(/scheduledAt/i);
      expect(social.schedulePost).not.toHaveBeenCalled();
    });
  });

  describe('jeeta.delete_social_post', () => {
    it('is DESTRUCTIVE and approval-gated in every mode', () => {
      const { registry } = build();
      const tool = registry.get('jeeta.delete_social_post')!;
      expect(tool.risk).toBe('DESTRUCTIVE');
      expect(tool.requiresApproval).toBe(true);
      expect(tool.approvalKind).toBe('DESTRUCTIVE');
      expect(tool.resourceType).toBe('social_post');
      expect(tool.resourceIdFrom!({ postId: 'p9' })).toBe('p9');
      expect(tool.scopes).toEqual(['campaigns.write']);
    });

    it('forwards to deletePost', async () => {
      const { registry, social } = build();
      const out = await registry
        .get('jeeta.delete_social_post')!
        .handler(ctx(['campaigns.write']), { postId: 'p1' });
      expect(social.deletePost).toHaveBeenCalledWith('ws1', 'p1');
      expect(out).toEqual({ deleted: true });
    });
  });
});

describe('Faz 5 D2 — jeeta.list_scheduled_posts gains date + ANY filters', () => {
  const posts = [
    { id: 'p1', status: 'SCHEDULED', scheduledAt: '2026-08-01T10:00:00.000Z' },
    { id: 'p2', status: 'DRAFT', scheduledAt: null },
    { id: 'p3', status: 'PUBLISHED', scheduledAt: '2026-09-20T10:00:00.000Z' },
    { id: 'p4', status: 'SCHEDULED', scheduledAt: '2026-12-01T10:00:00.000Z' },
  ];

  it('still defaults to SCHEDULED', async () => {
    const { registry } = build({ listPosts: jest.fn().mockResolvedValue(posts) });
    const out = (await registry
      .get('jeeta.list_scheduled_posts')!
      .handler(ctx(['campaigns.read']), {})) as Array<{ id: string }>;
    expect(out.map((p) => p.id)).toEqual(['p1', 'p4']);
  });

  it('status: ANY returns every status', async () => {
    const { registry } = build({ listPosts: jest.fn().mockResolvedValue(posts) });
    const out = (await registry
      .get('jeeta.list_scheduled_posts')!
      .handler(ctx(['campaigns.read']), { status: 'ANY' })) as Array<{ id: string }>;
    expect(out).toHaveLength(4);
  });

  it('narrows to a scheduledAt window when from/to are given', async () => {
    const { registry } = build({ listPosts: jest.fn().mockResolvedValue(posts) });
    const out = (await registry.get('jeeta.list_scheduled_posts')!.handler(ctx(['campaigns.read']), {
      status: 'ANY',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    })) as Array<{ id: string }>;
    // p2 has no scheduledAt at all, so a date window excludes it.
    expect(out.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('caps the result set so a huge workspace cannot blow the context window', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, status: 'DRAFT', scheduledAt: null }));
    const { registry } = build({ listPosts: jest.fn().mockResolvedValue(many) });
    const out = (await registry
      .get('jeeta.list_scheduled_posts')!
      .handler(ctx(['campaigns.read']), { status: 'DRAFT' })) as unknown[];
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('rejects an unparseable from/to', async () => {
    const { registry } = build({ listPosts: jest.fn().mockResolvedValue(posts) });
    await expect(
      registry.get('jeeta.list_scheduled_posts')!.handler(ctx(['campaigns.read']), { from: 'yesterday' }),
    ).rejects.toThrow(/from/i);
  });
});
