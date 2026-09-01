import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ContentDistributionService } from '../../src/modules/marketing/distribution/content-distribution.service';
import { DistributionSendService } from '../../src/modules/marketing/distribution/distribution-send.service';
import { SocialCampaignsService } from '../../src/modules/marketing/social-campaigns/social-campaigns.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * İçerik üretim hattı, aşama 4 — the distribution plan against REAL Postgres.
 *
 * Four things only real SQL settles here.
 *
 * 1. **Two new tables round-trip.** `content_distribution_plans` and
 *    `distribution_drafts` arrived in migration 20260901220000. A mocked Prisma
 *    accepts a write to a column that does not exist.
 * 2. **The unique index IS the idempotency.** Re-planning the same item must
 *    not stack a second copy of a message beside one a human may already have
 *    edited. That is a property of `@@unique([planId, leadId, channelType])` and
 *    `skipDuplicates`, and it can only be observed by counting rows after two
 *    real inserts.
 * 3. **Tenant isolation, cross-stamped.** The neighbour workspace below holds a
 *    connected account, a contactable lead, an ACTIVE email channel and its own
 *    campaign item — a complete, plausible mirror of ours. A dropped
 *    `workspaceId` predicate therefore does not merely return nothing, it
 *    returns THEIR customer as a person to message about OUR video. Each
 *    predicate gets its own assertion.
 * 4. **THE SEND BOUNDARY, end to end.** The unit spec proves the human check
 *    with a mocked actor. This proves it against real rows: the workspace's
 *    actual SYSTEM sentinel — created the way `McpPrincipalService` creates it —
 *    is refused, a real OWNER is not, and a MANAGER whose `MarketingUser` row
 *    lives in ANOTHER workspace but who holds an ACTIVE membership of this one
 *    is ADMITTED. That last shape is the one neither existing test covered and
 *    the one the frozen `MarketingUser` mirror got wrong: the guard resolves the
 *    request's workspace from the MEMBERSHIP, so a multi-workspace manager was
 *    403'd from a screen their own session had just opened.
 * 5. **The CHECK constraint, in Postgres.** `distribution_drafts_sent_by_present`
 *    refuses `status = 'SENT'` with a null `sentById`, on INSERT and on UPDATE.
 *    That is the only part of this design a future caller cannot route around —
 *    the source scan in `distribution-send.boundary.spec.ts` looks for two
 *    service names, and a job that dispatches through `MessageSenderService`
 *    directly uses neither. A constraint can only be observed against real SQL.
 *
 * `OutboundConversationService` is the ONE seam cut, and only at its dispatch:
 * a test that put a message on the wire would be sending real email. Everything
 * up to that line is the real thing.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Content distribution, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let distribution: ContentDistributionService;

  const SEED = `dist-${randomUUID().slice(0, 8)}`;

  const workspaceId = randomUUID(); // ours
  const otherWorkspaceId = randomUUID(); // the neighbour
  const emptyWorkspaceId = randomUUID(); // connected to nothing — the cold start
  const packageId = randomUUID();
  const ownerId = randomUUID();
  const systemId = randomUUID();
  const otherOwnerId = randomUUID();
  // The multi-workspace shape. Created in the NEIGHBOUR workspace (so the frozen
  // `MarketingUser.workspaceId` mirror says "not ours"), holding an ACTIVE
  // membership of OURS — which is what `MarketingGuard` resolves the request's
  // workspace and role from. prod already contains memberships of this shape;
  // see `McpPrincipalService.assertActiveMember`.
  const managerElsewhereId = randomUUID();

  const campaignId = randomUUID();
  const itemId = randomUUID();
  const conceptId = randomUUID();
  const postId = randomUUID();
  const accountIgId = randomUUID();
  const accountLiId = randomUUID();
  const channelId = randomUUID();
  const leadId = randomUUID();
  const optedOutLeadId = randomUUID();

  // The neighbour's complete mirror.
  const otherCampaignId = randomUUID();
  const otherItemId = randomUUID();
  const otherAccountId = randomUUID();
  const otherChannelId = randomUUID();
  const otherLeadId = randomUUID();

  const emptyCampaignId = randomUUID();
  const emptyItemId = randomUUID();

  /** The send path, with only the final dispatch seamed out. */
  const sender = (start = jest.fn().mockResolvedValue({
    conversationId: randomUUID(),
    to: 'x@example.com',
    channel: 'EMAIL',
  })) => ({ svc: new DistributionSendService(prisma, { start } as never), start });

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp());
    distribution = new ContentDistributionService(prisma);

    await prisma.workspace.createMany({
      data: [
        { id: workspaceId, slug: `${SEED}-a`, name: 'Dist A', productName: 'Figurunica' },
        { id: otherWorkspaceId, slug: `${SEED}-b`, name: 'Dist B', productName: 'Next Door' },
        { id: emptyWorkspaceId, slug: `${SEED}-c`, name: 'Dist C', productName: 'Cold Start' },
      ],
    });

    await prisma.package.create({
      data: {
        id: packageId,
        code: `${SEED}-PKG`,
        name: 'Dist Plan',
        dailyLeadQuota: -1,
        maxUsers: 10,
        maxResearchProfiles: 1,
        features: { socialCampaigns: true, mediaGen: true, conversationAi: true },
        limits: { aiCreditsMonthly: -1 },
        priceMonthlyTRY: 1,
        priceMonthlyUSD: 1,
      },
    });
    for (const ws of [workspaceId, otherWorkspaceId, emptyWorkspaceId]) {
      await prisma.workspaceSubscription.create({
        data: {
          workspaceId: ws,
          packageId,
          status: 'ACTIVE',
          currency: 'TRY',
          currentPeriodStart: new Date(Date.now() - 86_400_000),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }

    await prisma.marketingUser.createMany({
      data: [
        {
          id: ownerId,
          workspaceId,
          email: `${SEED}-owner@example.com`,
          firstName: 'Olive',
          lastName: 'Owner',
          role: 'OWNER',
          status: 'ACTIVE',
          password: 'x',
        },
        // The real sentinel, shaped the way McpPrincipalService writes it. This
        // is what an unattended agent session resolves to, and the send must
        // refuse it against a REAL row rather than a mocked role string.
        {
          id: systemId,
          workspaceId,
          email: `${SEED}-system@example.com`,
          firstName: 'Jeeta',
          lastName: 'Automation',
          role: 'SYSTEM',
          status: 'ACTIVE',
          password: 'x',
        },
        {
          id: otherOwnerId,
          workspaceId: otherWorkspaceId,
          email: `${SEED}-other-owner@example.com`,
          firstName: 'Nabil',
          lastName: 'Neighbour',
          role: 'OWNER',
          status: 'ACTIVE',
          password: 'x',
        },
        {
          id: managerElsewhereId,
          // HOME workspace is the neighbour's. The mirror is wrong about this
          // person on purpose.
          workspaceId: otherWorkspaceId,
          email: `${SEED}-manager-elsewhere@example.com`,
          firstName: 'Mira',
          lastName: 'Multi',
          role: 'REP',
          status: 'ACTIVE',
          password: 'x',
        },
      ],
    });

    // The LIVE truth. `MarketingUser.workspaceId/role/status` are stamped at row
    // creation and never re-derived; these rows are what the guard — and now the
    // send gate — actually read.
    await prisma.workspaceMembership.createMany({
      data: [
        { userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE', acceptedAt: new Date() },
        // Ours by membership, the neighbour's by birth, and a MANAGER here even
        // though the mirror calls them a REP over there.
        {
          userId: managerElsewhereId,
          workspaceId,
          role: 'MANAGER',
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
        {
          userId: otherOwnerId,
          workspaceId: otherWorkspaceId,
          role: 'OWNER',
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
        // The sentinel with a membership it does not have in prod
        // (`createResearchSentinel` mints no membership row). Given one HERE on
        // purpose: it is the harder case, and it is what keeps the SYSTEM
        // exclusion load-bearing instead of dead code shadowed by "no
        // membership".
        { userId: systemId, workspaceId, role: 'SYSTEM', status: 'ACTIVE', acceptedAt: new Date() },
      ],
    });

    // ————— ours —————
    await prisma.socialAccount.createMany({
      data: [
        {
          id: accountIgId,
          workspaceId,
          network: 'INSTAGRAM',
          externalId: `${SEED}-ig`,
          displayName: 'figurunica',
          accessToken: 'sealed',
          enabled: true,
        },
        {
          id: accountLiId,
          workspaceId,
          network: 'LINKEDIN',
          externalId: `${SEED}-li`,
          displayName: 'Figurunica Ltd',
          accessToken: 'sealed',
          enabled: true,
        },
      ],
    });
    await prisma.channel.create({
      data: { id: channelId, workspaceId, type: 'EMAIL', name: 'Mail', status: 'ACTIVE' },
    });
    await prisma.lead.createMany({
      data: [
        {
          id: leadId,
          workspaceId,
          businessName: 'Kahve Durağı',
          contactPerson: 'Ayşe',
          email: `${SEED}-ayse@example.com`,
          businessType: 'cafe',
          source: 'MANUAL',
        },
        // Opted out of the only channel this workspace has. A plan that proposed
        // messaging her would be proposing something the send path refuses.
        {
          id: optedOutLeadId,
          workspaceId,
          businessName: 'Sessiz Dükkan',
          contactPerson: 'Mert',
          email: `${SEED}-mert@example.com`,
          emailOptOut: true,
          businessType: 'cafe',
          source: 'MANUAL',
        },
      ],
    });
    await prisma.socialCampaign.create({
      data: {
        id: campaignId,
        workspaceId,
        name: 'Strandbeest',
        brief: {},
        status: 'ACTIVE',
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: { perWeek: 2, daysOfWeek: [1, 4], timeOfDay: '10:00' },
        startDate: new Date(),
        targetAccountIds: [accountIgId],
        mediaKinds: ['VIDEO'],
        createdById: ownerId,
      },
    });
    await prisma.contentConcept.create({
      data: {
        id: conceptId,
        workspaceId,
        batchId: randomUUID(),
        sourceIdea: 'Theo Jansen Strandbeest',
        angle: 'curiosity',
        hook: 'Bunun motoru yok.',
        title: 'Motorsuz yürüyen şey',
        ordinal: 0,
        shotPlan: { captionSuggestion: 'Rüzgarla yürüyor.', shots: [] },
        status: 'APPROVED',
        createdById: ownerId,
      },
    });
    await prisma.socialPost.create({
      data: {
        id: postId,
        workspaceId,
        content: 'Bunun motoru yok.',
        mediaUrls: [],
        status: 'PUBLISHED',
        publishedAt: new Date(),
        socialCampaignId: campaignId,
        campaignItemId: itemId,
      },
    });
    await prisma.socialCampaignItem.create({
      data: {
        id: itemId,
        socialCampaignId: campaignId,
        workspaceId,
        sequenceIndex: 0,
        scheduledFor: new Date(),
        status: 'PUBLISHED',
        contentConceptId: conceptId,
        socialPostId: postId,
        topic: 'Bunun motoru yok.',
      },
    });
    await prisma.socialPostTarget.create({
      data: {
        workspaceId,
        postId,
        socialAccountId: accountIgId,
        network: 'INSTAGRAM',
        status: 'PUBLISHED',
      },
    });

    // ————— the neighbour: a complete, plausible mirror —————
    await prisma.socialAccount.create({
      data: {
        id: otherAccountId,
        workspaceId: otherWorkspaceId,
        network: 'FACEBOOK',
        externalId: `${SEED}-fb`,
        displayName: 'NEIGHBOUR PAGE',
        accessToken: 'sealed',
        enabled: true,
      },
    });
    await prisma.channel.create({
      data: {
        id: otherChannelId,
        workspaceId: otherWorkspaceId,
        type: 'EMAIL',
        name: 'Neighbour mail',
        status: 'ACTIVE',
      },
    });
    await prisma.lead.create({
      data: {
        id: otherLeadId,
        workspaceId: otherWorkspaceId,
        businessName: 'NEIGHBOUR CUSTOMER',
        contactPerson: 'Nobody',
        email: `${SEED}-neighbour@example.com`,
        businessType: 'cafe',
        source: 'MANUAL',
      },
    });
    await prisma.socialCampaign.create({
      data: {
        id: otherCampaignId,
        workspaceId: otherWorkspaceId,
        name: 'Neighbour campaign',
        brief: {},
        status: 'ACTIVE',
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: { perWeek: 1, daysOfWeek: [1], timeOfDay: '10:00' },
        startDate: new Date(),
        targetAccountIds: [otherAccountId],
        mediaKinds: ['VIDEO'],
        createdById: otherOwnerId,
      },
    });
    await prisma.socialCampaignItem.create({
      data: {
        id: otherItemId,
        socialCampaignId: otherCampaignId,
        workspaceId: otherWorkspaceId,
        sequenceIndex: 0,
        scheduledFor: new Date(),
        status: 'PUBLISHED',
        topic: 'Neighbour topic',
      },
    });

    // ————— the cold start: a workspace connected to nothing —————
    await prisma.socialCampaign.create({
      data: {
        id: emptyCampaignId,
        workspaceId: emptyWorkspaceId,
        name: 'Cold start',
        brief: {},
        status: 'ACTIVE',
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: { perWeek: 1, daysOfWeek: [1], timeOfDay: '10:00' },
        startDate: new Date(),
        targetAccountIds: [],
        mediaKinds: ['VIDEO'],
        createdById: ownerId,
      },
    });
    await prisma.socialCampaignItem.create({
      data: {
        id: emptyItemId,
        socialCampaignId: emptyCampaignId,
        workspaceId: emptyWorkspaceId,
        sequenceIndex: 0,
        scheduledFor: new Date(),
        status: 'APPROVED',
        topic: 'Nothing connected',
      },
    });
  });

  afterAll(async () => {
    if (!realDbEnabled()) return;
    const all = { in: [workspaceId, otherWorkspaceId, emptyWorkspaceId] };
    await prisma.distributionDraft.deleteMany({ where: { workspaceId: all } });
    await prisma.contentDistributionPlan.deleteMany({ where: { workspaceId: all } });
    await prisma.socialPostTarget.deleteMany({ where: { workspaceId: all } });
    await prisma.socialPost.deleteMany({ where: { workspaceId: all } });
    await prisma.socialCampaignItem.deleteMany({ where: { workspaceId: all } });
    await prisma.socialCampaign.deleteMany({ where: { workspaceId: all } });
    await prisma.contentConcept.deleteMany({ where: { workspaceId: all } });
    await prisma.socialAccount.deleteMany({ where: { workspaceId: all } });
    await prisma.contactIdentity.deleteMany({ where: { workspaceId: all } });
    await prisma.conversation.deleteMany({ where: { workspaceId: all } });
    await prisma.channel.deleteMany({ where: { workspaceId: all } });
    await prisma.lead.deleteMany({ where: { workspaceId: all } });
    await prisma.workspaceMembership.deleteMany({
      where: { userId: { in: [ownerId, systemId, otherOwnerId, managerElsewhereId] } },
    });
    await prisma.marketingUser.deleteMany({
      where: { id: { in: [ownerId, systemId, otherOwnerId, managerElsewhereId] } },
    });
    await prisma.workspaceSubscription.deleteMany({ where: { workspaceId: all } });
    await prisma.package.deleteMany({ where: { id: packageId } });
    await prisma.workspace.deleteMany({ where: { id: all } });
    await closeTestApp(app);
  });

  /**
   * THE cold-start question. A workspace with nothing connected must be told to
   * connect something — not handed a plan with two empty sections.
   */
  it('refuses a workspace with zero connected accounts, and names the fix', async () => {
    await expect(
      distribution.plan(emptyWorkspaceId, emptyItemId, ownerId),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(distribution.plan(emptyWorkspaceId, emptyItemId, ownerId)).rejects.toThrow(
      /Connect one first/,
    );
    // And nothing was written, so the refusal is not a half-produced plan.
    expect(
      await prisma.contentDistributionPlan.count({ where: { workspaceId: emptyWorkspaceId } }),
    ).toBe(0);
    expect(
      await prisma.distributionDraft.count({ where: { workspaceId: emptyWorkspaceId } }),
    ).toBe(0);
  });

  it('produces a plan whose rows land in the real tables', async () => {
    const res = await distribution.plan(workspaceId, itemId, ownerId);

    const row = await prisma.contentDistributionPlan.findUniqueOrThrow({
      where: { campaignItemId: itemId },
    });
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.socialCampaignId).toBe(campaignId);
    expect(row.contentConceptId).toBe(conceptId);

    // Published on Instagram, so LinkedIn is the cross-post.
    expect(res.plan.publishedNetworks).toEqual(['INSTAGRAM']);
    expect(res.plan.crossPosts.map((c) => c.network)).toEqual(['LINKEDIN']);
    // Own accounts only.
    expect(res.plan.tags.accounts.map((a) => a.displayName).sort()).toEqual([
      'Figurunica Ltd',
      'figurunica',
    ]);
  });

  it('prepares a draft for the contactable person and NOT for the one who opted out', async () => {
    const drafts = await prisma.distributionDraft.findMany({ where: { workspaceId } });
    expect(drafts.map((d) => d.leadId)).toEqual([leadId]);
    expect(drafts[0].status).toBe('DRAFT');
    expect(drafts[0].sentAt).toBeNull();
    expect(drafts[0].sentById).toBeNull();
    expect(drafts[0].body).toContain('Bunun motoru yok.');
    expect(drafts[0].channelType).toBe('EMAIL');
    // The plan says WHY the other person is not on the list.
    const plan = await distribution.get(workspaceId, itemId);
    expect(plan.plan.gaps.some((g) => g.area === 'outreach')).toBe(false);
  });

  /**
   * The unique index at work. Re-planning must not stack a second copy of a
   * message a human may already have edited — and a read-then-create guard
   * cannot promise that, only Postgres can.
   */
  it('is idempotent: re-planning keeps ONE plan and ONE draft per person', async () => {
    await distribution.plan(workspaceId, itemId, ownerId);
    await distribution.plan(workspaceId, itemId, ownerId);

    expect(await prisma.contentDistributionPlan.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.distributionDraft.count({ where: { workspaceId } })).toBe(1);
  });

  describe('tenant isolation — the neighbour is a complete mirror', () => {
    it('refuses the neighbour’s item outright', async () => {
      await expect(distribution.plan(workspaceId, otherItemId, ownerId)).rejects.toThrow(
        /does not exist in this workspace/,
      );
    });

    it('never names the neighbour’s account among what to tag or cross-post to', async () => {
      const plan = await distribution.get(workspaceId, itemId);
      const named = [
        ...plan.plan.tags.accounts.map((a) => a.displayName),
        ...plan.plan.crossPosts.map((c) => c.accountName),
      ];
      expect(named).not.toContain('NEIGHBOUR PAGE');
    });

    it('never proposes contacting the neighbour’s customer', async () => {
      const drafts = await prisma.distributionDraft.findMany({ where: { workspaceId } });
      expect(drafts.map((d) => d.leadId)).not.toContain(otherLeadId);
      expect(drafts.map((d) => d.channelId)).not.toContain(otherChannelId);
    });

    it('does not list the neighbour’s drafts, nor ours to them', async () => {
      await distribution.plan(otherWorkspaceId, otherItemId, otherOwnerId).catch(() => undefined);
      const ours = await distribution.listDrafts(workspaceId);
      expect(ours.every((d) => d.workspaceId === workspaceId)).toBe(true);
      const theirs = await distribution.listDrafts(otherWorkspaceId);
      expect(theirs.some((d) => d.workspaceId === workspaceId)).toBe(false);
    });
  });

  describe('the send boundary, against real user rows', () => {
    let draftId: string;

    beforeAll(async () => {
      if (!realDbEnabled()) return;
      const d = await prisma.distributionDraft.findFirstOrThrow({ where: { workspaceId } });
      draftId = d.id;
    });

    /**
     * The whole stage, in one assertion. The workspace's REAL SYSTEM sentinel —
     * the principal an unattended MCP session resolves to — is refused, and the
     * row is untouched.
     */
    it('refuses the workspace’s real SYSTEM sentinel', async () => {
      const { svc, start } = sender();
      await expect(svc.send(workspaceId, draftId, systemId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(start).not.toHaveBeenCalled();
      const after = await prisma.distributionDraft.findUniqueOrThrow({ where: { id: draftId } });
      expect(after.status).toBe('DRAFT');
      expect(after.sentById).toBeNull();
    });

    it('refuses a real human who belongs to the OTHER workspace', async () => {
      const { svc, start } = sender();
      await expect(svc.send(workspaceId, draftId, otherOwnerId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(start).not.toHaveBeenCalled();
    });

    /**
     * THE multi-workspace case, and the reason this file grew a fourth user.
     *
     * Mira's `MarketingUser` row says workspace B — she was created there — and
     * her mirrored role says REP. Her ACTIVE `WorkspaceMembership` says
     * workspace A, MANAGER. `MarketingGuard` resolves the request from the
     * MEMBERSHIP, so her session is a perfectly ordinary manager session of A;
     * the old gate read the mirror and 403'd her from a screen her own token
     * had just opened, with "requires an active member of this workspace".
     *
     * It failed SAFE, which is why nothing caught it — and it made the feature
     * unusable for everyone in more than one workspace.
     */
    it('admits a MANAGER whose home workspace is the neighbour but whose membership is ours', async () => {
      // Her own draft: the one above has been claimed by the owner's send, and
      // the point of this test is the ACTOR, not the row.
      const mine = await prisma.distributionDraft.findFirstOrThrow({ where: { workspaceId } });
      const hers = await prisma.distributionDraft.create({
        data: {
          workspaceId,
          planId: mine.planId,
          campaignItemId: itemId,
          leadId: optedOutLeadId,
          channelType: 'SMS',
          channelId,
          toAddress: '+905551112233',
          body: 'Mira kendi cümleleriyle.',
          status: 'DRAFT',
        },
      });

      const conversationId = randomUUID();
      const { svc, start } = sender(
        jest.fn().mockResolvedValue({ conversationId, to: '+905551112233', channel: 'SMS' }),
      );
      const res = await svc.send(workspaceId, hers.id, managerElsewhereId);
      expect(res.conversationId).toBe(conversationId);
      expect(start).toHaveBeenCalledTimes(1);

      const after = await prisma.distributionDraft.findUniqueOrThrow({ where: { id: hers.id } });
      expect(after.status).toBe('SENT');
      // Stamped with HER, not with the workspace her row was created in.
      expect(after.sentById).toBe(managerElsewhereId);

      await prisma.distributionDraft.delete({ where: { id: hers.id } });
    });

    /** The same person, membership revoked. A mirror-based read would still let
     *  her through — that is the direction of this bug that actually matters. */
    it('refuses her the moment the membership stops being ACTIVE', async () => {
      const mine = await prisma.distributionDraft.findFirstOrThrow({ where: { workspaceId } });
      const hers = await prisma.distributionDraft.create({
        data: {
          workspaceId,
          planId: mine.planId,
          campaignItemId: itemId,
          leadId: optedOutLeadId,
          channelType: 'WHATSAPP',
          channelId,
          toAddress: '+905551112233',
          body: 'Bu gitmemeli.',
          status: 'DRAFT',
        },
      });
      await prisma.workspaceMembership.updateMany({
        where: { userId: managerElsewhereId, workspaceId },
        data: { status: 'SUSPENDED' },
      });

      const { svc, start } = sender();
      await expect(svc.send(workspaceId, hers.id, managerElsewhereId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(start).not.toHaveBeenCalled();
      expect(
        (await prisma.distributionDraft.findUniqueOrThrow({ where: { id: hers.id } })).status,
      ).toBe('DRAFT');

      await prisma.workspaceMembership.updateMany({
        where: { userId: managerElsewhereId, workspaceId },
        data: { status: 'ACTIVE' },
      });
      await prisma.distributionDraft.delete({ where: { id: hers.id } });
    });

    it('sends for a real, active human — and stamps the row with who did it', async () => {
      const conversationId = randomUUID();
      const { svc, start } = sender(
        jest.fn().mockResolvedValue({ conversationId, to: 'a@example.com', channel: 'EMAIL' }),
      );
      const res = await svc.send(workspaceId, draftId, ownerId, 'Kendi cümlelerimle.');
      expect(res.conversationId).toBe(conversationId);
      expect(start).toHaveBeenCalledTimes(1);

      const after = await prisma.distributionDraft.findUniqueOrThrow({ where: { id: draftId } });
      expect(after.status).toBe('SENT');
      expect(after.sentById).toBe(ownerId);
      expect(after.sentAt).toBeInstanceOf(Date);
      // What was SENT, not what was proposed.
      expect(after.body).toBe('Kendi cümlelerimle.');
      expect(after.conversationId).toBe(conversationId);
    });

    it('will not send the same draft a second time', async () => {
      const { svc, start } = sender();
      await expect(svc.send(workspaceId, draftId, ownerId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(start).not.toHaveBeenCalled();
    });

    /** Re-planning after a send must not resurrect the message as a fresh
     *  draft — the unique index is what stops it, on a row whose status has
     *  moved on. */
    it('re-planning after a send does not recreate the sent message', async () => {
      await distribution.plan(workspaceId, itemId, ownerId);
      const rows = await prisma.distributionDraft.findMany({ where: { workspaceId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('SENT');
    });
  });

  /**
   * The part of the boundary no caller can route around.
   *
   * `distribution-send.boundary.spec.ts` scans the source for two service
   * NAMES. A scheduled job that dispatches through `MessageSenderService`
   * directly uses neither, and one added during review wrote `status: 'SENT'`
   * with a null `sentById` while all 593 suites stayed green.
   * `distribution_drafts_sent_by_present` is the answer, and a CHECK constraint
   * is a thing only real SQL can be asked about.
   */
  describe('the constraint: a SENT row must name the person who sent it', () => {
    const base = () => ({
      workspaceId,
      planId: randomUUID(),
      campaignItemId: itemId,
      leadId,
      channelType: 'EMAIL',
      channelId,
      toAddress: 'x@example.com',
      body: 'nope',
    });

    it('refuses an INSERT of a SENT row with nobody attached', async () => {
      await expect(
        prisma.distributionDraft.create({
          data: { ...base(), status: 'SENT', sentAt: new Date(), sentById: null },
        }),
      ).rejects.toThrow(/distribution_drafts_sent_by_present/);
    });

    it('refuses an UPDATE that flips a DRAFT to SENT without one', async () => {
      const row = await prisma.distributionDraft.create({ data: { ...base(), status: 'DRAFT' } });
      await expect(
        prisma.distributionDraft.update({
          where: { id: row.id },
          data: { status: 'SENT', sentAt: new Date() },
        }),
      ).rejects.toThrow(/distribution_drafts_sent_by_present/);
      // Raw SQL too — the constraint is not something an ORM is choosing to do.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "distribution_drafts" SET "status" = 'SENT', "sentById" = NULL WHERE "id" = $1`,
          row.id,
        ),
      ).rejects.toThrow(/distribution_drafts_sent_by_present/);
      await prisma.distributionDraft.delete({ where: { id: row.id } });
    });

    /** The control. Without it, a constraint that refused EVERYTHING would pass
     *  both tests above and take the whole feature down with it. */
    it('allows the same row when a person IS named, and every other status freely', async () => {
      const sent = await prisma.distributionDraft.create({
        data: { ...base(), status: 'SENT', sentAt: new Date(), sentById: ownerId },
      });
      expect(sent.sentById).toBe(ownerId);
      await prisma.distributionDraft.delete({ where: { id: sent.id } });

      for (const status of ['DRAFT', 'DISMISSED', 'FAILED'] as const) {
        const row = await prisma.distributionDraft.create({
          data: { ...base(), status, sentById: null },
        });
        expect(row.status).toBe(status);
        await prisma.distributionDraft.delete({ where: { id: row.id } });
      }
    });
  });

  /**
   * Claim 9, asserted instead of assumed.
   *
   * `jeeta.plan_content_distribution` REQUIRES a `campaignItemId`, and
   * `jeeta.list_social_campaigns` is the only tool in the catalogue that
   * returns one — which is what makes `ID_SOURCES`' entry for `campaignItemId`
   * true rather than aspirational. `ID_SOURCES` only checks that the NAMED TOOL
   * EXISTS, so removing the `include: { items }` from `SocialCampaignsService
   * .list` left the whole suite green (593/6618), tsc clean, and the MCP tool
   * impossible to call.
   */
  describe('the campaign item id is discoverable, which is what makes planning possible', () => {
    it('list() carries each campaign’s items, and every item carries its id', async () => {
      const campaigns = await app.get(SocialCampaignsService).list(workspaceId);
      const ours = campaigns.find((c) => c.id === campaignId) as unknown as {
        items?: Array<{ id: string; status: string }>;
      };
      expect(ours).toBeDefined();
      expect(Array.isArray(ours.items)).toBe(true);
      expect(ours.items!.length).toBeGreaterThan(0);
      for (const item of ours.items!) expect(typeof item.id).toBe('string');
      // And the specific id planning needs is actually in there.
      expect(ours.items!.map((i) => i.id)).toContain(itemId);
    });

    /** End to end, so this cannot pass on an id that the planner would reject:
     *  the id discovered from `list()` is the one `plan()` accepts. */
    it('the id it returns is one plan() will accept', async () => {
      const campaigns = await app.get(SocialCampaignsService).list(workspaceId);
      const discovered = (
        campaigns.find((c) => c.id === campaignId) as unknown as { items: Array<{ id: string }> }
      ).items[0].id;
      await expect(distribution.plan(workspaceId, discovered, ownerId)).resolves.toMatchObject({
        campaignItemId: discovered,
      });
    });

    it('does not carry the neighbour’s items', async () => {
      const campaigns = await app.get(SocialCampaignsService).list(workspaceId);
      const allItemIds = campaigns.flatMap(
        (c) => ((c as unknown as { items?: Array<{ id: string }> }).items ?? []).map((i) => i.id),
      );
      expect(allItemIds).not.toContain(otherItemId);
    });
  });
});
