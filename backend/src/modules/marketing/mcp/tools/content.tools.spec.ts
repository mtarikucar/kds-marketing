import { ForbiddenException } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContentTools } from './content.tools';

function build(over: { features?: Record<string, boolean> } = {}) {
  const registry = new McpToolRegistry();
  const calendar = { range: jest.fn().mockResolvedValue([]) };
  const media = {
    requestGeneration: jest.fn().mockResolvedValue({ assetId: 'as1' }),
    listAssets: jest.fn().mockResolvedValue([]),
    getAsset: jest.fn().mockResolvedValue({ id: 'as1' }),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue({ id: 'sys-1', workspaceId: 'ws1', role: 'SYSTEM' }),
    assertActiveMember: jest.fn(),
  };
  const entitlements = {
    getEffective: jest
      .fn()
      .mockResolvedValue({ features: over.features ?? { mediaGen: true, socialCampaigns: true } }),
  };
  registerContentTools(registry, {
    calendar: calendar as never,
    media: media as never,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, calendar, media, principals, entitlements };
}

const ctx = (extra: Record<string, unknown> = {}) => ({
  workspaceId: 'ws1',
  grantedScopes: [],
  ...extra,
});

describe('Faz 5 D2 — jeeta.get_content_calendar', () => {
  it('is a plain read on reports.read (mirrors the REST content-calendar gate)', () => {
    const tool = build().registry.get('jeeta.get_content_calendar')!;
    expect(tool.risk).toBe('READ');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['reports.read']);
  });

  it('forwards a parsed from/to window', async () => {
    const { registry, calendar } = build();
    await registry
      .get('jeeta.get_content_calendar')!
      .handler(ctx(), { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' });
    expect(calendar.range).toHaveBeenCalledWith(
      'ws1',
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
  });

  it('defaults to the same window the panel uses when the caller gives none', async () => {
    const { registry, calendar } = build();
    await registry.get('jeeta.get_content_calendar')!.handler(ctx(), {});
    const [, from, to] = calendar.range.mock.calls[0];
    expect(to.getTime()).toBeGreaterThan(from.getTime());
    expect(from.getTime()).toBeLessThan(Date.now());
    expect(to.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses an inverted or over-wide range, like the REST controller does', async () => {
    const { registry } = build();
    const tool = registry.get('jeeta.get_content_calendar')!;
    await expect(
      tool.handler(ctx(), { from: '2026-09-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    ).rejects.toThrow(/after/i);
    await expect(
      tool.handler(ctx(), { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/180/);
  });

  it('refuses an unparseable date', async () => {
    const { registry } = build();
    await expect(
      registry.get('jeeta.get_content_calendar')!.handler(ctx(), { from: 'sometime in august' }),
    ).rejects.toThrow(/from/i);
  });
});

describe('Faz 5 D2 — AI media generation', () => {
  it.each([
    ['jeeta.generate_image', 'IMAGE'],
    ['jeeta.generate_video', 'VIDEO'],
  ])('%s is SPEND + approval-gated in every mode', (name) => {
    const tool = build().registry.get(name)!;
    expect(tool.risk).toBe('SPEND');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('MEDIA_SPEND');
    expect(tool.scopes).toEqual(['campaigns.send']);
  });

  it('generate_image reserves credits through MediaGenService, never its own metering', async () => {
    const { registry, media } = build();
    await registry
      .get('jeeta.generate_image')!
      .handler(ctx(), { prompt: 'a plate of manti', aspectRatio: '4:5' });
    expect(media.requestGeneration).toHaveBeenCalledWith('ws1', {
      type: 'IMAGE',
      prompt: 'a plate of manti',
      aspectRatio: '4:5',
      createdById: 'sys-1',
    });
  });

  it('generate_video forwards the duration and defaults nothing else', async () => {
    const { registry, media } = build();
    await registry
      .get('jeeta.generate_video')!
      .handler(ctx(), { prompt: 'dough being rolled', durationSec: 8, model: 'fal-ai/veo3/fast' });
    expect(media.requestGeneration).toHaveBeenCalledWith('ws1', {
      type: 'VIDEO',
      prompt: 'dough being rolled',
      durationSec: 8,
      model: 'fal-ai/veo3/fast',
      createdById: 'sys-1',
    });
  });

  it('attributes the generation to the resolved principal, never a fabricated id', async () => {
    const { registry, media, principals } = build();
    principals.resolve.mockResolvedValue({ id: 'u9', workspaceId: 'ws1', role: 'MANAGER' });
    await registry.get('jeeta.generate_image')!.handler(ctx({ userId: 'u9' }), { prompt: 'x' });
    expect(principals.resolve).toHaveBeenCalled();
    expect(media.requestGeneration.mock.calls[0][1].createdById).toBe('u9');
  });

  it('refuses cleanly on a package without mediaGen — and never reaches the provider', async () => {
    const { registry, media } = build({ features: { mediaGen: false, socialCampaigns: true } });
    const err = await registry
      .get('jeeta.generate_image')!
      .handler(ctx(), { prompt: 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'FEATURE_NOT_IN_PACKAGE', feature: 'mediaGen' }),
    );
    expect(media.requestGeneration).not.toHaveBeenCalled();
  });

  it('checks the entitlement BEFORE resolving a principal or spending anything', async () => {
    const { registry, principals } = build({ features: { mediaGen: false } });
    await registry.get('jeeta.generate_video')!.handler(ctx(), { prompt: 'x' }).catch(() => undefined);
    expect(principals.resolve).not.toHaveBeenCalled();
  });

  describe('jeeta.list_generated_media', () => {
    it('is a plain read behind the same mediaGen entitlement', async () => {
      const { registry, media } = build();
      const tool = registry.get('jeeta.list_generated_media')!;
      expect(tool.risk).toBe('READ');
      expect(tool.requiresApproval).toBe(false);
      expect(tool.scopes).toEqual(['campaigns.read']);
      await tool.handler(ctx(), { type: 'IMAGE', status: 'READY' });
      expect(media.listAssets).toHaveBeenCalledWith('ws1', { type: 'IMAGE', status: 'READY' });
    });

    it('refuses cleanly without mediaGen', async () => {
      const { registry, media } = build({ features: { mediaGen: false } });
      await expect(
        registry.get('jeeta.list_generated_media')!.handler(ctx(), {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(media.listAssets).not.toHaveBeenCalled();
    });
  });
});

/**
 * The linkage arguments (design brief, stage 2). `RequestGenerationDto` has
 * always accepted `socialCampaignId`/`campaignItemId`, but the tool's schema
 * exposed neither, so EVERY MCP-generated asset landed with
 * `socialCampaignId = null` — which put it on `sweepOrphanAssets`' 30-day
 * delete list and off the armed-budget path.
 */
describe('the campaign an MCP generation belongs to', () => {
  /**
   * BOTH media tools, in one table.
   *
   * The commit that added the ids claimed "every MCP-generated asset was an
   * orphan" and then only fixed `generate_video`, so `generate_image` — the
   * PRIMARY media entry point, the one that is not even deferred — went on
   * writing `socialCampaignId = null` and went on being deleted at 30 days.
   * The single-tool spec is what let that read as done, so the table is the
   * fix: a tool added to the media family without its linkage now has to be
   * added here, or left out on purpose.
   */
  it.each(['jeeta.generate_image', 'jeeta.generate_video'])(
    '%s forwards both linkage ids so the asset is not orphan-reaped',
    async (name) => {
      const { registry, media } = build();
      await registry.get(name)!.handler(ctx(), {
        prompt: 'a walking sculpture',
        socialCampaignId: 'camp-1',
        campaignItemId: 'item-1',
      });
      expect(media.requestGeneration).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({ socialCampaignId: 'camp-1', campaignItemId: 'item-1' }),
      );
    },
  );

  /** The schema is the gate, not the handler: a handler that forwards an id its
   *  zod schema strips is a handler that forwards nothing. */
  it.each(['jeeta.generate_image', 'jeeta.generate_video'])(
    '%s accepts both ids in its declared input schema',
    (name) => {
      const shape = (registryOf().get(name)!.inputSchema as never as {
        shape: Record<string, unknown>;
      }).shape;
      expect(Object.keys(shape)).toEqual(
        expect.arrayContaining(['socialCampaignId', 'campaignItemId']),
      );
    },
  );

  it.each(['jeeta.generate_image', 'jeeta.generate_video'])(
    '%s omits them entirely when the caller named neither',
    async (name) => {
      // Not `undefined` — omitted. The service distinguishes "no campaign" from
      // "a campaign I could not resolve", and only the second is an error.
      const { registry, media } = build();
      await registry.get(name)!.handler(ctx(), { prompt: 'x' });
      const dto = media.requestGeneration.mock.calls[0][1];
      expect('socialCampaignId' in dto).toBe(false);
      expect('campaignItemId' in dto).toBe(false);
    },
  );
});

function registryOf() {
  return build().registry;
}
