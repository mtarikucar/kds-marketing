import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialCampaignsService, SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, generateDedup } from './social-campaigns.service';
import { CONCEPT_PRODUCE_KIND, produceDedup } from '../content-concepts/concept-promotion.service';
import { CampaignItemArmingService, confirmDedup } from './campaign-item-arming.service';

const WS = 'ws-1';
const SLOT = new Date('2026-07-08T09:00:00Z');

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', status: 'ACTIVE', automationMode: 'FULL_AUTO',
    targetAccountIds: ['acc-1'], dailyPublishCap: 2, ...over,
  };
}
function makeItem(over: Partial<any> = {}) {
  return { id: 'i-1', socialCampaignId: 'c-1', workspaceId: WS, scheduledFor: SLOT, status: 'SCHEDULED', socialPostId: 'post-1', campaign: makeCampaign(), ...over };
}

function build() {
  const prisma: any = {
    socialCampaign: { findUnique: jest.fn().mockResolvedValue({ stats: null }), update: jest.fn() },
    socialCampaignItem: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    socialPost: { findFirst: jest.fn().mockResolvedValue({ id: 'post-1', content: 'Nice copy' }), update: jest.fn() },
    generatedAsset: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const scheduledJobs = { schedule: jest.fn(), cancel: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn() };
  const planner = { schedulePost: jest.fn().mockResolvedValue({}) };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn().mockResolvedValue({ text: 'SAFE' }) };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn() };
  // The REAL arming service, on the same prisma/scheduledJobs fakes: the
  // post-generation branch is a shared autonomy rule now, and a stub here would
  // stop these tests from checking the rule they were written to check.
  const arming = new CampaignItemArmingService(prisma, scheduledJobs as any);
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
    arming,
  );
  return { svc, prisma, scheduledJobs, planner, anthropic, credits, arming };
}
const confirm = (svc: any) => (svc as any).confirmItem('i-1', WS);

describe('confirmItem — gate, cap rollover, brand-safety', () => {
  it('FULL_AUTO under cap + SAFE copy → publishes via the planner, item PUBLISHED', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.count.mockResolvedValueOnce(0);
    await confirm(svc);
    expect(planner.schedulePost).toHaveBeenCalledWith(WS, 'post-1', expect.any(Date), ['acc-1']);
    // PUBLISHED is claimed atomically (SCHEDULED → PUBLISHED) before publishing so
    // a mid-publish retry can't re-charge brand-safety or re-send.
    expect(prisma.socialCampaignItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'i-1', status: { in: ['SCHEDULED'] } }),
        data: { status: 'PUBLISHED' },
      }),
    );
  });

  it('idempotent: a lost publish claim (count 0) does not publish or re-charge', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.updateMany.mockResolvedValueOnce({ count: 0 }); // already claimed by a prior run
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(anthropic.complete).not.toHaveBeenCalled(); // brand-safety not re-charged
  });

  it('waits (reschedules) when the generated media is not yet READY instead of publishing text-only', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ scheduledFor: new Date(), generatedAssetIds: ['asset-1'] }),
    );
    prisma.generatedAsset.findMany.mockResolvedValueOnce([{ status: 'GENERATING' }]);
    const res = await confirm(svc);
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { itemId: 'i-1', workspaceId: WS } }) });
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.updateMany).not.toHaveBeenCalled();
  });

  it('multi-media: waits when ANY asset is still generating even if another is READY (no orphaned media)', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ scheduledFor: new Date(), generatedAssetIds: ['img-1', 'vid-1'] }),
    );
    // image ready, video still generating → must WAIT, not publish image-only.
    prisma.generatedAsset.findMany.mockResolvedValueOnce([{ status: 'READY' }, { status: 'GENERATING' }]);
    const res = await confirm(svc);
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { itemId: 'i-1', workspaceId: WS } }) });
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.updateMany).not.toHaveBeenCalled(); // not yet claimed/published
  });

  it('SEMI_AUTO auto-publishes a NEEDS_APPROVAL item the user did not reject', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ status: 'NEEDS_APPROVAL', campaign: makeCampaign({ automationMode: 'SEMI_AUTO' }) }),
    );
    await confirm(svc);
    expect(prisma.socialCampaignItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'i-1', status: { in: ['SCHEDULED', 'NEEDS_APPROVAL'] } }),
        data: { status: 'PUBLISHED' },
      }),
    );
    expect(planner.schedulePost).toHaveBeenCalled();
  });

  it('over dailyPublishCap → reschedules to the next day, no publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.count.mockResolvedValueOnce(2); // cap = 2 already published today
    const res = await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    const next = new Date('2026-07-09T09:00:00Z');
    expect(res).toEqual({ reschedule: { runAt: next, payload: { itemId: 'i-1', workspaceId: WS } } });
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scheduledFor: next }) }),
    );
  });

  it('brand-safety BLOCK → item SKIPPED, no publish', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    anthropic.complete.mockResolvedValueOnce({ text: 'BLOCK' });
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED', error: expect.stringContaining('brand-safety') }) }),
    );
  });

  it('a user veto (item already SKIPPED) cancels the pending publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'SKIPPED' }));
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
  });

  it('stop-on-pause: paused campaign → no publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ campaign: makeCampaign({ status: 'PAUSED' }) }));
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
  });

  it('skips the Claude check (treats as safe) when AI is disabled', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    anthropic.isEnabled.mockReturnValue(false);
    await confirm(svc);
    expect(anthropic.complete).not.toHaveBeenCalled();
    expect(planner.schedulePost).toHaveBeenCalled();
  });
});

/**
 * THE WINDOW, AND THE INVARIANT UNDER IT.
 *
 * The media-ready wait is bounded, and it used to measure that bound from
 * `scheduledFor` — a CALENDAR SLOT — on the assumption that the gate fires at
 * the slot. The content-concept producer broke the assumption: it buys clips at
 * production time and reschedules itself for up to an hour while the workspace
 * generation queue is full, so a FULL_AUTO item with a slot ten minutes out is
 * routinely armed an HOUR after that slot with every clip still QUEUED. The
 * gate then fired, computed an hour of "waiting" that nobody did, skipped the
 * wait branch, attached nothing, and published the caption to every target with
 * an empty mediaUrls.
 *
 * Two fixes, and the second is the load-bearing one: the window now starts when
 * the gate was ARMED, and — however the clock lands — a post built around
 * generated media never goes out with none of it.
 */
describe('confirmItem — the media-ready window, and the empty-media publish', () => {
  const HOUR = 60 * 60 * 1000;

  it('an item ARMED long after its slot still gets its full wait', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({
        // The slot passed two hours ago…
        scheduledFor: new Date(Date.now() - 2 * HOUR),
        // …and the clips were only submitted (and the gate only armed) now.
        armedAt: new Date(),
        generatedAssetIds: ['clip-1'],
      }),
    );
    prisma.generatedAsset.findMany.mockResolvedValueOnce([{ id: 'clip-1', status: 'QUEUED', url: null }]);

    const res = await confirm(svc);

    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { itemId: 'i-1', workspaceId: WS } }) });
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.updateMany).not.toHaveBeenCalled();
  });

  it('never publishes a caption where a video was approved: no usable media → held, nothing sent', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({
        scheduledFor: new Date(Date.now() - 2 * HOUR),
        armedAt: new Date(Date.now() - 2 * HOUR),
        generatedAssetIds: ['clip-1', 'clip-2'],
      }),
    );
    // The wait is genuinely over — and this is exactly the state the old code
    // published in: nothing READY, so `attachAssetsToPost` wrote no mediaUrls
    // and the post went out as a bare caption.
    prisma.generatedAsset.findMany.mockResolvedValueOnce([
      { id: 'clip-1', status: 'QUEUED', url: null },
      { id: 'clip-2', status: 'FAILED', url: null },
    ]);

    await confirm(svc);

    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
    expect(anthropic.complete).not.toHaveBeenCalled(); // never even paid for brand-safety
    const held = prisma.socialCampaignItem.updateMany.mock.calls.at(-1)[0];
    expect(held.data.status).toBe('FAILED');
    expect(held.data.error).toMatch(/none of them can be sent/);
    expect(held.data.error).toMatch(/QUEUED/);
    // Conditional on the same publishable states, so a gate that lost the race
    // to another runner changes nothing.
    expect(held.where).toEqual(expect.objectContaining({ id: 'i-1', status: { in: ['SCHEDULED'] } }));
  });

  it('a clip whose row says READY but has no file is not a publishable clip', async () => {
    // The other shape of the same silence: `attachAssetsToPost` selected
    // status READY and then wrote `mediaUrls` from rows that carry no url, so a
    // post could go out with an empty array while every asset "was ready".
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ generatedAssetIds: ['clip-1'] }),
    );
    prisma.generatedAsset.findMany.mockResolvedValueOnce([
      { id: 'clip-1', status: 'READY', url: null, r2Key: null, mime: null },
    ]);

    await confirm(svc);

    expect(planner.schedulePost).not.toHaveBeenCalled();
    const held = prisma.socialCampaignItem.updateMany.mock.calls.at(-1)[0];
    expect(held.data.status).toBe('FAILED');
    expect(held.data.error).toMatch(/READY but no file/);
  });

  it('an item that never had media publishes exactly as before', async () => {
    // The guard is about a post built AROUND generated files. A text-only item
    // has none to lose and must not be caught by it.
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ generatedAssetIds: [] }));
    await confirm(svc);
    expect(planner.schedulePost).toHaveBeenCalled();
  });

  it('publishes with the clips it HAS, and records the ones it could not attach', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({
        scheduledFor: new Date(Date.now() - 2 * HOUR),
        armedAt: new Date(Date.now() - 2 * HOUR),
        generatedAssetIds: ['clip-1', 'clip-2', 'clip-3'],
      }),
    );
    prisma.generatedAsset.findMany.mockResolvedValueOnce([
      { id: 'clip-1', status: 'READY', url: 'https://cdn/clip-1.mp4', r2Key: 'k1', mime: 'video/mp4' },
      { id: 'clip-2', status: 'FAILED', url: null, r2Key: null, mime: null },
      { id: 'clip-3', status: 'QUEUED', url: null, r2Key: null, mime: null },
    ]);

    await confirm(svc);

    // It publishes — one READY clip is a post, and holding it back would throw
    // away the render that DID work.
    expect(planner.schedulePost).toHaveBeenCalled();
    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mediaUrls: ['https://cdn/clip-1.mp4'] }) }),
    );
    // …and the two paid-for clips that did not go out are ON THE ROW, not
    // dropped in silence one layer above the adapters that now report the same
    // thing about their own drops.
    const note = prisma.socialCampaignItem.update.mock.calls
      .map((c: [{ data: Record<string, unknown> }]) => String(c[0].data.error ?? ''))
      .find((e: string) => e.length > 0);
    expect(note).toMatch(/2 of 3/);
    expect(note).toMatch(/FAILED/);
    expect(note).toMatch(/paid for/);
  });

  /**
   * "N of M" WAS COUNTED OVER THE ROWS THAT CAME BACK, not the ids that were
   * PAID FOR.
   *
   * `generatedAssetIds` is one id per beat, one purchase each. The report was
   * built from the `findMany` result, so a clip whose row had vanished entirely
   * was missing from BOTH sides of the fraction: five bought, two rows found,
   * one attached, and the item said "1 of 2" — or, when the found rows all
   * attached, said nothing wrong at all. The id is the receipt; the row is only
   * evidence about it.
   */
  it('counts the clips that were PAID FOR, not the rows that happened to come back', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({
        scheduledFor: new Date(Date.now() - 2 * HOUR),
        armedAt: new Date(Date.now() - 2 * HOUR),
        generatedAssetIds: ['clip-1', 'clip-2', 'clip-3'],
      }),
    );
    // clip-2 and clip-3 have no rows AT ALL — the worst case, and the one that
    // used to be reported as nothing wrong.
    prisma.generatedAsset.findMany.mockResolvedValueOnce([
      { id: 'clip-1', status: 'READY', url: 'https://cdn/clip-1.mp4', r2Key: 'k1', mime: 'video/mp4' },
    ]);

    await confirm(svc);

    expect(planner.schedulePost).toHaveBeenCalled();
    const note = prisma.socialCampaignItem.update.mock.calls
      .map((c: [{ data: Record<string, unknown> }]) => String(c[0].data.error ?? ''))
      .find((e: string) => e.length > 0);
    // THREE were bought; two of them are gone.
    expect(note).toMatch(/2 of 3/);
    expect(note).toMatch(/the asset row no longer exists/);
    expect(note).toMatch(/paid for/);
  });

  it('says nothing when every clip was attached', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ generatedAssetIds: ['clip-1'] }),
    );
    prisma.generatedAsset.findMany.mockResolvedValueOnce([
      { id: 'clip-1', status: 'READY', url: 'https://cdn/clip-1.mp4', r2Key: 'k1', mime: 'video/mp4' },
    ]);

    await confirm(svc);

    const notes = prisma.socialCampaignItem.update.mock.calls
      .map((c: [{ data: Record<string, unknown> }]) => c[0].data.error)
      .filter((e: unknown) => typeof e === 'string' && e.length > 0);
    expect(notes).toEqual([]);
  });

  it('publishes the beats in the order they were bought, not the order the database hands them back', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ generatedAssetIds: ['clip-1', 'clip-2', 'clip-3'] }),
    );
    // What a real `findMany({ where: { id: { in: [...] } } })` is entitled to
    // return: the rows, in no particular order. There is no ORDER BY, so
    // Postgres owes the caller nothing — and these rows are each updated twice
    // on the way to READY, so heap order genuinely diverges from insertion
    // order. Every existing spec in this file happens to hand them back already
    // sorted, which is exactly why nothing caught this.
    prisma.generatedAsset.findMany.mockResolvedValueOnce([
      { id: 'clip-3', status: 'READY', url: 'https://cdn/payoff.mp4', r2Key: 'k3', mime: 'video/mp4' },
      { id: 'clip-1', status: 'READY', url: 'https://cdn/hook.mp4', r2Key: 'k1', mime: 'video/mp4' },
      { id: 'clip-2', status: 'READY', url: 'https://cdn/proof.mp4', r2Key: 'k2', mime: 'video/mp4' },
    ]);

    await confirm(svc);

    // `generatedAssetIds` is beat order, `mediaUrls` is what an Instagram
    // carousel plays in order, so the two must agree: the hook first and the
    // payoff last. Published in scan order the concept plays its call-to-action
    // before its hook — the whole point of refusing to publish a partial shot
    // plan is that the beats are not interchangeable.
    expect(prisma.socialPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mediaUrls: ['https://cdn/hook.mp4', 'https://cdn/proof.mp4', 'https://cdn/payoff.mp4'],
        }),
      }),
    );
    // The mime/key sidecar is read positionally by the publish path too
    // (`mediaMime: mediaUrls.map((u) => mimeByUrl[u])` is keyed by url, but
    // `options.media` is what a reader sees), so it has to carry the same order.
    const written = prisma.socialPost.update.mock.calls.at(-1)[0].data.options.media;
    expect(written.map((m: { key: string }) => m.key)).toEqual(['k1', 'k2', 'k3']);
  });
});

describe('item approve / reject / regenerate', () => {
  it('approveItem: NEEDS_APPROVAL → SCHEDULED and arms the confirm gate', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));
    await svc.approveItem(WS, 'i-1');
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SCHEDULED', armedAt: expect.any(Date) } }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, payload: { itemId: 'i-1', workspaceId: WS } }),
    );
  });

  it('approveItem arms through the SHARED service — the third copy of the rule is gone', async () => {
    // Not a style point. Arming is what opens the media-ready window
    // (`armedAt`), and this door kept its own copy of status + schedule + dedup
    // when the shared service was extracted. A copy that forgets the stamp is a
    // door that publishes a caption with no video — so the door is tested for
    // going through the one implementation, by its one observable signature.
    const { svc, prisma, scheduledJobs, arming } = build();
    const armApproved = jest.spyOn(arming, 'armApproved');
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));

    await svc.approveItem(WS, 'i-1');

    expect(armApproved).toHaveBeenCalledWith({
      workspaceId: WS,
      itemId: 'i-1',
      scheduledFor: SLOT,
    });
    // and exactly one confirm job, under the shared dedup key
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
    expect(scheduledJobs.schedule.mock.calls[0][0].dedupKey).toBe(confirmDedup('i-1'));
  });

  it('rejectItem → SKIPPED', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));
    await svc.rejectItem(WS, 'i-1');
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SKIPPED' } }),
    );
  });

  it('regenerateItem re-enqueues generation', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'FAILED' }));
    await svc.regenerateItem(WS, 'i-1');
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, dedupKey: generateDedup('i-1'),
    }));
  });

  it('regenerateItem on a PROMOTED item re-runs the CONCEPT, not the generic planner', async () => {
    // Regenerating through the generic path would compose fresh copy and a
    // stock image over the shot plan a human approved — the shot plan is the
    // whole content, and the generic generator has never heard of it. It would
    // also leave the item PLANNED with a topic, which confirmPlan then sweeps
    // into that same generator.
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ status: 'FAILED', contentConceptId: 'concept-1', generatedAssetIds: ['a-1'] }),
    );

    await svc.regenerateItem(WS, 'i-1');

    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: CONCEPT_PRODUCE_KIND, dedupKey: produceDedup('i-1'),
    }));
    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND,
    }));
    // GENERATING, not PLANNED. And a FAILED promoted item RESUMES: the clips
    // already bought are kept as the cursor (see the pair of tests below).
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'GENERATING', error: null, socialPostId: null },
    }));
  });

  /**
   * Fix 7 — regenerating the most expensive object in the product.
   *
   * The split is on the SOURCE STATE, because that is what says which of two
   * different requests this is.
   *
   * FAILED means production stopped part-way through a spend. The shot plan on
   * the concept is immutable — nothing in the product can edit it — so beats
   * already bought are byte-for-byte the beats that would be bought again.
   * Resuming is therefore never worse than rebuilding: identical output, and at
   * worst identical cost (when nothing had been bought yet, resume IS rebuild).
   *
   * NEEDS_APPROVAL means a human has SEEN the finished clips and is asking for
   * different ones. There the cursor must go, or "regenerate" returns the same
   * video and reads as a broken button.
   */
  it('regenerating a FAILED promoted item RESUMES — it does not re-buy beats it owns', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ status: 'FAILED', contentConceptId: 'concept-1', generatedAssetIds: ['a-1', 'a-2'] }),
    );

    await svc.regenerateItem(WS, 'i-1');

    const { data } = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(data.status).toBe('GENERATING');
    // The key assertion: the cursor is not in the write at all, so the two
    // clips this workspace already paid for survive and produce() starts at 3.
    expect(data).not.toHaveProperty('generatedAssetIds');
  });

  it('regenerating a promoted item a human has SEEN clears the cursor and re-buys', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(
      makeItem({ status: 'NEEDS_APPROVAL', contentConceptId: 'concept-1', generatedAssetIds: ['a-1', 'a-2'] }),
    );

    await svc.regenerateItem(WS, 'i-1');

    const { data } = prisma.socialCampaignItem.update.mock.calls.at(-1)[0];
    expect(data.status).toBe('GENERATING');
    expect(data.generatedAssetIds).toEqual([]);
  });

  it('regenerateItem rejects a PUBLISHED item (no re-charge / re-publish)', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'PUBLISHED' }));
    await expect(svc.regenerateItem(WS, 'i-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('rejectItem rejects a PUBLISHED (already-live) item', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'PUBLISHED' }));
    await expect(svc.rejectItem(WS, 'i-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.socialCampaignItem.update).not.toHaveBeenCalled();
  });

  it('approveItem throws NotFound for an unknown item', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(null);
    await expect(svc.approveItem(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
