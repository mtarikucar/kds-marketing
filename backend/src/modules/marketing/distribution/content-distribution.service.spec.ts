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

function makeSvc(f: Fixture = {}, Ctor: typeof ContentDistributionService = ContentDistributionService) {
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
  return { svc: new Ctor(prisma), prisma, created };
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
      // The one that was missing. `publishedNetworks()` reads
      // social_post_targets by post id, and a post id is not tenant-scoped on
      // its own — dropping the workspaceId there was silent across the WHOLE
      // suite, and the consequence is not an empty list: it is the neighbour's
      // publish history deciding which networks OUR video still needs.
      prisma.socialPostTarget.findMany,
    ]) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: OTHER_WS }) }),
      );
      expect(call).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
      );
    }
  });

  /** The loop above proves each predicate is PRESENT. This proves the query it
   *  is on actually ran — a read that never happens is trivially well-scoped,
   *  and `toHaveBeenCalledWith` on an uncalled mock is not what fails. */
  it('actually performs every read the loop above checks', async () => {
    const { svc, prisma } = makeSvc();
    await svc.plan(OTHER_WS, ITEM, ACTOR);
    for (const call of [
      prisma.socialCampaignItem.findFirst,
      prisma.socialAccount.findMany,
      prisma.channel.findMany,
      prisma.lead.findMany,
      prisma.contentConcept.findFirst,
      prisma.socialPostTarget.findMany,
    ]) {
      expect(call).toHaveBeenCalled();
    }
  });

  it('stamps every draft it writes with the calling workspace', async () => {
    const { svc, created } = makeSvc();
    await svc.plan(OTHER_WS, ITEM, ACTOR);
    expect(created.every((d: any) => d.workspaceId === OTHER_WS)).toBe(true);
  });
});

/**
 * The stagger, and the crash a typo used to cause.
 *
 * `Number(process.env.X ?? 4h_default)` returns `NaN` for any non-numeric
 * value, `NaN` survives the `base + (i + 1) * stagger` arithmetic, and
 * `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`. The
 * failure is not a wrong schedule — it is EVERY plan in the workspace failing,
 * including the outreach drafts and the tag list, which have nothing to do with
 * scheduling and would give the operator no way to connect the error to the
 * variable they set.
 */
describe('CROSS_POST_STAGGER_MS — a junk env value must not break every plan', () => {
  const ORIGINAL = process.env.DISTRIBUTION_CROSS_POST_STAGGER_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISTRIBUTION_CROSS_POST_STAGGER_MS;
    else process.env.DISTRIBUTION_CROSS_POST_STAGGER_MS = ORIGINAL;
    jest.resetModules();
  });

  /** Re-imported per case: the constant is read once, at module load, which is
   *  exactly why a bad value is a deploy-time landmine rather than a bad row. */
  function load(value: string | undefined) {
    if (value === undefined) delete process.env.DISTRIBUTION_CROSS_POST_STAGGER_MS;
    else process.env.DISTRIBUTION_CROSS_POST_STAGGER_MS = value;
    let mod!: typeof import('./content-distribution.service');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('./content-distribution.service');
    });
    return mod;
  }

  it.each([
    ['a duration nobody told it not to write', '4h'],
    ['empty', ''],
    ['whitespace', '   '],
    ['literally NaN', 'NaN'],
    ['zero, which IS simultaneous posting', '0'],
    ['negative, which schedules into the past', '-3600000'],
  ])('falls back to four hours when the value is %s', (_why, value) => {
    expect(load(value).CROSS_POST_STAGGER_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('still honours a legitimate override', () => {
    expect(load('60000').CROSS_POST_STAGGER_MS).toBe(60_000);
  });

  /**
   * The assertion that the constant test cannot make: that a plan still comes
   * out. Before the guard this threw RangeError from `toISOString()` and the
   * whole feature was down for that workspace.
   */
  it('produces a plan with real timestamps even so', async () => {
    const mod = load('4h');
    const { svc } = makeSvc({}, mod.ContentDistributionService);
    const res = await svc.plan(WS, ITEM, ACTOR);
    expect(res.plan.crossPosts.length).toBeGreaterThan(0);
    for (const c of res.plan.crossPosts) {
      expect(Number.isNaN(Date.parse(c.runAt))).toBe(false);
    }
  });
});
