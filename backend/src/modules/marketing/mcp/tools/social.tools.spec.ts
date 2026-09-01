import { McpToolRegistry } from '../mcp-tool-registry';
import { registerSocialTools } from './social.tools';

const deps = () => ({
  social: {
    listPosts: jest.fn(),
    createPost: jest.fn(),
    publishNow: jest.fn(),
  } as any,
});

describe('social MCP tools', () => {
  it('registers the list and draft tools ungated', () => {
    const registry = new McpToolRegistry();
    registerSocialTools(registry, deps());

    const list = registry.get('jeeta.list_scheduled_posts')!;
    expect(list.risk).toBe('READ');
    expect(list.requiresApproval).toBe(false);
    expect(list.scopes).toEqual(['campaigns.read']);
    expect(list.inputSchema).toBeDefined();

    const draft = registry.get('jeeta.draft_social_post')!;
    expect(draft.risk).toBe('WRITE');
    expect(draft.requiresApproval).toBe(false);
    expect(draft.scopes).toEqual(['campaigns.write']);
    expect(draft.inputSchema).toBeDefined();
  });

  it('hides draft_social_post from a caller without campaigns.write', () => {
    const registry = new McpToolRegistry();
    registerSocialTools(registry, deps());
    expect(registry.list(['campaigns.read']).map((t) => t.name)).not.toContain('jeeta.draft_social_post');
  });

  it('grants draft_social_post to a caller with campaigns.write but withholds publish_social_post (draft without publish authority)', () => {
    const registry = new McpToolRegistry();
    registerSocialTools(registry, deps());
    const names = registry.list(['campaigns.read', 'campaigns.write']).map((t) => t.name);
    expect(names).toContain('jeeta.draft_social_post');
    expect(names).not.toContain('jeeta.publish_social_post');
  });

  it('legacy "read"/"write" (expanded) reach neither draft_social_post nor publish_social_post', () => {
    const registry = new McpToolRegistry();
    registerSocialTools(registry, deps());
    // MCP_READ_SCOPES/MCP_WRITE_SCOPES (mcp-scopes.ts) never include campaigns.write/campaigns.send.
    const legacyReadExpanded = ['leads.read', 'contacts.read', 'campaigns.read', 'reports.read', 'tasks.read'];
    const legacyWriteExpanded = [...legacyReadExpanded, 'leads.write', 'tasks.write'];
    for (const scopes of [legacyReadExpanded, legacyWriteExpanded]) {
      const names = registry.list(scopes).map((t) => t.name);
      expect(names).not.toContain('jeeta.draft_social_post');
      expect(names).not.toContain('jeeta.publish_social_post');
    }
  });

  it('gates jeeta.publish_social_post behind PUBLISH approval', () => {
    const registry = new McpToolRegistry();
    registerSocialTools(registry, deps());
    const tool = registry.get('jeeta.publish_social_post')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('PUBLISH');
    expect(tool.scopes).toEqual(['campaigns.send']);
  });

  it('hides publish_social_post from a caller without campaigns.send', () => {
    const registry = new McpToolRegistry();
    registerSocialTools(registry, deps());
    expect(registry.list(['campaigns.read']).map((t) => t.name)).not.toContain('jeeta.publish_social_post');
  });

  it('jeeta.list_scheduled_posts defaults to SCHEDULED and pushes the filter down', async () => {
    const registry = new McpToolRegistry();
    const listPosts = jest.fn().mockResolvedValue([
      { id: 'p1', status: 'SCHEDULED' },
      { id: 'p2', status: 'DRAFT' },
    ]);
    registerSocialTools(registry, { social: { ...deps().social, listPosts } as any });
    const out = await registry
      .get('jeeta.list_scheduled_posts')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.read'] }, {});
    // The status and the cap go to the SERVICE, not just to a client-side
    // filter. This used to call `listPosts('ws1')` bare and sift the result
    // here, which was merely wasteful until the service grew an unconditional
    // page cap ordered by CREATION time — after which a window filtered on
    // SCHEDULED time was being evaluated over a set already truncated by the
    // wrong column, and a busy workspace's next week could come back empty.
    expect(listPosts).toHaveBeenCalledWith('ws1', { status: 'SCHEDULED', limit: 100 });
    // The client-side sift stays as a backstop, so a service that ignored the
    // filter still cannot leak a DRAFT into a "scheduled posts" answer.
    expect(out).toEqual([{ id: 'p1', status: 'SCHEDULED' }]);
  });

  it('jeeta.list_scheduled_posts honours an explicit status override', async () => {
    const registry = new McpToolRegistry();
    const listPosts = jest.fn().mockResolvedValue([
      { id: 'p1', status: 'SCHEDULED' },
      { id: 'p2', status: 'DRAFT' },
    ]);
    registerSocialTools(registry, { social: { ...deps().social, listPosts } as any });
    const out = await registry
      .get('jeeta.list_scheduled_posts')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.read'] }, { status: 'DRAFT' });
    expect(out).toEqual([{ id: 'p2', status: 'DRAFT' }]);
  });

  it('jeeta.draft_social_post forwards content + media + targets to createPost', async () => {
    const registry = new McpToolRegistry();
    const createPost = jest.fn().mockResolvedValue({ id: 'post1', status: 'DRAFT' });
    registerSocialTools(registry, { social: { ...deps().social, createPost } as any });
    const out = await registry
      .get('jeeta.draft_social_post')!
      .handler(
        { workspaceId: 'ws1', grantedScopes: ['campaigns.write'] },
        { content: 'hello world', mediaUrls: ['https://x/img.png'], targetAccountIds: ['acc1'] },
      );
    expect(createPost).toHaveBeenCalledWith('ws1', {
      content: 'hello world',
      mediaUrls: ['https://x/img.png'],
      targetAccountIds: ['acc1'],
    });
    expect(out).toEqual({ id: 'post1', status: 'DRAFT' });
  });

  it('jeeta.publish_social_post forwards to publishNow', async () => {
    const registry = new McpToolRegistry();
    const publishNow = jest.fn().mockResolvedValue({ id: 'post1', status: 'PUBLISHED' });
    registerSocialTools(registry, { social: { ...deps().social, publishNow } as any });
    const out = await registry
      .get('jeeta.publish_social_post')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.send'] }, { postId: 'post1' });
    expect(publishNow).toHaveBeenCalledWith('ws1', 'post1');
    expect(out).toEqual({ id: 'post1', status: 'PUBLISHED' });
  });
});
