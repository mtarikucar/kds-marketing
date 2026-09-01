import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ContentDistributionService,
  OUTREACH_LIMIT,
  DISTRIBUTABLE_ITEM_STATUSES,
} from './content-distribution.service';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const ITEM = 'item-1';
const ACTOR = 'user-1';

const future = new Date(Date.now() + 30 * 86_400_000);

function account(over: Record<string, unknown> = {}) {
  return {
    id: 'acc-ig',
    workspaceId: WS,
    network: 'INSTAGRAM',
    displayName: 'figurunica',
    externalId: 'ig-123',
    accountType: 'IG_BUSINESS',
    enabled: true,
    lastError: null,
    tokenExpiresAt: future,
    ...over,
  };
}

function lead(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    businessName: 'Kahve Durağı',
    contactPerson: 'Ayşe',
    phone: '+905551112233',
    whatsapp: null,
    email: 'ayse@example.com',
    emailOptOut: false,
    smsOptOut: false,
    waOptOut: false,
    emailVerifiedStatus: 'VALID',
    emailBouncedAt: null,
    updatedAt: new Date(),
    ...over,
  };
}

interface Fixture {
  item?: unknown;
  accounts?: unknown[];
  channels?: unknown[];
  leads?: unknown[];
  concept?: unknown;
  post?: unknown;
  targets?: unknown[];
  brandKit?: unknown;
  existingPlan?: unknown;
}

function makeSvc(f: Fixture = {}) {
  const created: unknown[] = [];
  const prisma: any = {
    socialCampaignItem: {
      findFirst: jest.fn().mockResolvedValue(
        f.item === undefined
          ? {
              id: ITEM,
              workspaceId: WS,
              socialCampaignId: 'camp-1',
              contentConceptId: 'concept-1',
              socialPostId: 'post-1',
              status: 'PUBLISHED',
              topic: 'Strandbeest',
            }
          : f.item,
      ),
    },
    socialAccount: {
      findMany: jest.fn().mockResolvedValue(f.accounts ?? [account()]),
    },
    socialPost: {
      findFirst: jest
        .fn()
        .mockResolvedValue(f.post === undefined ? { id: 'post-1', content: 'caption' } : f.post),
    },
    socialPostTarget: {
      findMany: jest.fn().mockResolvedValue(f.targets ?? []),
    },
    contentConcept: {
      findFirst: jest.fn().mockResolvedValue(
        f.concept === undefined
          ? {
              id: 'concept-1',
              hook: 'Bunun motoru yok.',
              title: 'Motorsuz yürüyen şey',
              shotPlan: { captionSuggestion: 'Rüzgarla yürüyor.' },
            }
          : f.concept,
      ),
    },
    channel: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          f.channels ?? [{ id: 'ch-email', type: 'EMAIL', status: 'ACTIVE', name: 'Mail' }],
        ),
    },
    lead: { findMany: jest.fn().mockResolvedValue(f.leads ?? [lead()]) },
    brandKit: {
      findUnique: jest
        .fn()
        .mockResolvedValue(f.brandKit === undefined ? { defaultHashtags: ['#kinetik'] } : f.brandKit),
    },
    contentDistributionPlan: {
      findFirst: jest.fn().mockResolvedValue(f.existingPlan ?? null),
      upsert: jest.fn().mockImplementation(({ create, update }: any) =>
        Promise.resolve({ id: 'plan-1', ...(create ?? update) }),
      ),
    },
    distributionDraft: {
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        created.push(...data);
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(created)),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return { svc: new ContentDistributionService(prisma), prisma, created };
}

describe('ContentDistributionService.plan — refusals that are not emptiness', () => {
  it('refuses an item that is not this workspace’s', async () => {
    const { svc, prisma } = makeSvc({ item: null });
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.socialCampaignItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
  });

  /**
   * A plan for an item nobody has approved would be planning to promote a video
   * that may never exist. Refused BY NAME, with the statuses that do qualify.
   */
  it('refuses an item that has not reached approval', async () => {
    const { svc } = makeSvc({
      item: { id: ITEM, workspaceId: WS, socialCampaignId: 'c', status: 'GENERATING' },
    });
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toThrow(/GENERATING/);
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toThrow(
      new RegExp(DISTRIBUTABLE_ITEM_STATUSES.join('|')),
    );
  });

  /**
   * THE zero-accounts case. A workspace with nothing connected must be told to
   * connect something — not handed a plan with an empty cross-post list, which
   * reads as "there is nothing to distribute" about a video it just paid to
   * make.
   */
  it('refuses, naming the fix, when no social account is connected', async () => {
    const { svc, prisma } = makeSvc({ accounts: [] });
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toThrow(/connect/i);
    // And it refuses BEFORE writing anything.
    expect(prisma.contentDistributionPlan.upsert).not.toHaveBeenCalled();
    expect(prisma.distributionDraft.createMany).not.toHaveBeenCalled();
  });

  it('refuses when every connected account needs reconnecting, and says which', async () => {
    const { svc } = makeSvc({
      accounts: [
        account({ id: 'a1', displayName: 'stale', lastError: 'reauth_required' }),
        account({ id: 'a2', network: 'FACEBOOK', displayName: 'off', enabled: false }),
      ],
    });
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toThrow(/reconnect/i);
    await expect(svc.plan(WS, ITEM, ACTOR)).rejects.toThrow(/stale/);
  });
});

describe('ContentDistributionService.plan — what it produces', () => {
  it('schedules a cross-post on every connected network the item is not already on', async () => {
    const { svc } = makeSvc({
      accounts: [
        account({ id: 'a-ig', network: 'INSTAGRAM', displayName: 'figurunica' }),
        account({ id: 'a-li', network: 'LINKEDIN', displayName: 'Figurunica Ltd' }),
        account({ id: 'a-fb', network: 'FACEBOOK', displayName: 'Figurunica Page' }),
      ],
      // Already published to Instagram.
      targets: [{ network: 'INSTAGRAM', socialAccountId: 'a-ig', status: 'PUBLISHED' }],
    });

    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.plan.publishedNetworks).toEqual(['INSTAGRAM']);
    expect(res.plan.crossPosts.map((c) => c.network).sort()).toEqual(['FACEBOOK', 'LINKEDIN']);
    // Staggered, not all at once — a simultaneous blast across every network is
    // the pattern platforms score as automation.
    const times = res.plan.crossPosts.map((c) => new Date(c.runAt).getTime());
    expect(times[1]).toBeGreaterThan(times[0]);
  });

  /**
   * Error is not emptiness, restated for the section that can legitimately come
   * back empty: an item already on every connected network has no cross-post to
   * schedule, and the plan must SAY that rather than show a blank list.
   */
  it('explains an empty cross-post list instead of leaving it blank', async () => {
    const { svc } = makeSvc({
      accounts: [account({ id: 'a-ig', network: 'INSTAGRAM' })],
      targets: [{ network: 'INSTAGRAM', socialAccountId: 'a-ig', status: 'PUBLISHED' }],
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.plan.crossPosts).toHaveLength(0);
    expect(res.plan.gaps.map((g) => g.area)).toContain('crossPost');
    expect(res.plan.gaps.find((g) => g.area === 'crossPost')?.reason).toMatch(/already/i);
  });

  /**
   * "Do not invent handles." The only accounts named are the workspace's OWN
   * connected ones, and the plan states plainly that third-party handles are not
   * proposed — because nothing in this product stores one.
   */
  it('tags only the workspace’s own connected accounts, and says why not others', async () => {
    const { svc } = makeSvc({
      accounts: [
        account({ id: 'a-ig', network: 'INSTAGRAM', displayName: 'figurunica' }),
        account({ id: 'a-li', network: 'LINKEDIN', displayName: 'Figurunica Ltd' }),
      ],
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.plan.tags.accounts.map((a) => a.displayName).sort()).toEqual([
      'Figurunica Ltd',
      'figurunica',
    ]);
    expect(res.plan.tags.hashtags).toEqual(['#kinetik']);
    expect(res.plan.gaps.find((g) => g.area === 'tags')?.reason).toMatch(/handle/i);
  });

  it('says the brand kit has no hashtags instead of showing an empty list', async () => {
    const { svc } = makeSvc({ brandKit: null });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.plan.tags.hashtags).toEqual([]);
    expect(res.plan.gaps.some((g) => g.area === 'tags' && /hashtag/i.test(g.reason))).toBe(true);
  });
});

describe('ContentDistributionService.plan — outreach drafts', () => {
  it('prepares one draft per contactable lead, on a channel that can START a conversation', async () => {
    const { svc, created } = makeSvc({
      leads: [lead({ id: 'l1' }), lead({ id: 'l2', email: 'b@example.com' })],
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.drafts).toHaveLength(2);
    expect(created.every((d: any) => d.status === 'DRAFT')).toBe(true);
    expect(created.every((d: any) => d.channelType === 'EMAIL')).toBe(true);
    expect(created.every((d: any) => d.sentAt === undefined || d.sentAt === null)).toBe(true);
  });

  /**
   * The channels the platforms allow a first move on, and no others. A draft
   * proposing an Instagram DM proposes something no send path can execute.
   */
  it('ignores a channel a conversation cannot be started on', async () => {
    const { svc } = makeSvc({
      channels: [
        { id: 'ch-ig', type: 'INSTAGRAM', status: 'ACTIVE', name: 'IG' },
        { id: 'ch-webchat', type: 'WEBCHAT', status: 'ACTIVE', name: 'Site' },
      ],
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.drafts).toHaveLength(0);
    expect(res.plan.gaps.some((g) => g.area === 'outreach' && /start a conversation/i.test(g.reason))).toBe(
      true,
    );
  });

  it('skips a lead who opted out of the only channel it has an address on', async () => {
    const { svc } = makeSvc({
      leads: [lead({ id: 'l1', emailOptOut: true, phone: null, whatsapp: null })],
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.drafts).toHaveLength(0);
    expect(res.plan.gaps.some((g) => g.area === 'outreach')).toBe(true);
  });

  it('skips a hard-bounced or invalid email address', async () => {
    const { svc } = makeSvc({
      leads: [
        lead({ id: 'l1', emailBouncedAt: new Date() }),
        lead({ id: 'l2', emailVerifiedStatus: 'INVALID' }),
      ],
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.drafts).toHaveLength(0);
  });

  it('bounds how many people one video proposes contacting, and says the bound', async () => {
    const many = Array.from({ length: OUTREACH_LIMIT + 10 }, (_, i) =>
      lead({ id: `l${i}`, email: `l${i}@example.com` }),
    );
    const { svc, prisma } = makeSvc({ leads: many.slice(0, OUTREACH_LIMIT) });
    await svc.plan(WS, ITEM, ACTOR);
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: OUTREACH_LIMIT }),
    );
  });

  /**
   * The copy comes from the concept a human already approved and already paid
   * an Opus call for. No second AI call: the creative work was done at planning
   * time, and a fresh generation here would spend credits to say the same thing
   * differently.
   */
  it('composes the draft from the approved concept, not from a new AI call', async () => {
    const { svc, created } = makeSvc();
    await svc.plan(WS, ITEM, ACTOR);
    expect((created[0] as any).body).toContain('Bunun motoru yok.');
    expect((created[0] as any).body).toContain('Rüzgarla yürüyor.');
  });

  it('says so when there is no copy to compose a draft from', async () => {
    const { svc } = makeSvc({
      concept: null,
      post: null,
      item: {
        id: ITEM,
        workspaceId: WS,
        socialCampaignId: 'c',
        status: 'APPROVED',
        topic: null,
        contentConceptId: null,
        socialPostId: null,
      },
    });
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.drafts).toHaveLength(0);
    expect(res.plan.gaps.some((g) => g.area === 'outreach' && /copy/i.test(g.reason))).toBe(true);
  });
});

describe('ContentDistributionService — tenant isolation', () => {
  /** Each predicate gets its OWN assertion: a shared "it was scoped" check
   *  passes while one of five queries has quietly lost its clause. */
  it('scopes every read to the calling workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.plan(OTHER_WS, ITEM, ACTOR);

    for (const call of [
      prisma.socialCampaignItem.findFirst,
      prisma.socialAccount.findMany,
      prisma.channel.findMany,
      prisma.lead.findMany,
      prisma.contentConcept.findFirst,
    ]) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: OTHER_WS }) }),
      );
      expect(call).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
      );
    }
  });

  it('stamps every draft it writes with the calling workspace', async () => {
    const { svc, created } = makeSvc();
    await svc.plan(OTHER_WS, ITEM, ACTOR);
    expect(created.every((d: any) => d.workspaceId === OTHER_WS)).toBe(true);
  });
});
