import {
  CampaignItemArmingService,
  SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
  armingFor,
  confirmDedup,
} from './campaign-item-arming.service';

const WS = 'ws-1';
const ITEM = 'item-1';
const SLOT = new Date('2026-09-05T09:00:00Z');

function harness() {
  const prisma: any = { socialCampaignItem: { update: jest.fn().mockResolvedValue({}) } };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const svc = new CampaignItemArmingService(prisma, scheduledJobs as never);
  return { svc, prisma, scheduledJobs };
}

/**
 * The autonomy rule, in ONE place.
 *
 * Two producers finish a campaign item — the generic AI generator and the
 * content-concept line — and the second ignored `automationMode` entirely,
 * writing NEEDS_APPROVAL and scheduling nothing. A FULL_AUTO workspace got a
 * second human gate the design explicitly did not want.
 *
 * These tests are the rule itself, so they are the rule for BOTH callers.
 */
describe('armingFor — what a finished item does next', () => {
  it('FULL_AUTO schedules itself: SCHEDULED, gate armed', () => {
    expect(armingFor('FULL_AUTO')).toEqual({ status: 'SCHEDULED', arm: true });
  });

  it('SEMI_AUTO is a review WINDOW: visible in the queue AND armed', () => {
    expect(armingFor('SEMI_AUTO')).toEqual({ status: 'NEEDS_APPROVAL', arm: true });
  });

  it('APPROVAL waits for a person: NEEDS_APPROVAL, nothing armed', () => {
    expect(armingFor('APPROVAL')).toEqual({ status: 'NEEDS_APPROVAL', arm: false });
  });

  it('a mode this code does not recognise falls to the STRICTEST branch', () => {
    // Fail closed. An unknown autonomy setting is not a licence to publish
    // unattended — if a new mode is added and this function is not taught it,
    // the failure must be "a human has to click", never "it went out on its own".
    expect(armingFor('SOMETHING_NEW')).toEqual({ status: 'NEEDS_APPROVAL', arm: false });
    expect(armingFor('')).toEqual({ status: 'NEEDS_APPROVAL', arm: false });
  });
});

describe('CampaignItemArmingService.arm', () => {
  it('FULL_AUTO: writes SCHEDULED with the producer fields and arms the confirm gate at the slot', async () => {
    const { svc, prisma, scheduledJobs } = harness();

    const decision = await svc.arm({
      workspaceId: WS,
      itemId: ITEM,
      automationMode: 'FULL_AUTO',
      scheduledFor: SLOT,
      data: { socialPostId: 'post-1', generatedAssetIds: ['a1', 'a2'] },
    });

    expect(decision).toEqual({ status: 'SCHEDULED', arm: true });
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      // The producer's fields land in the SAME write as the status, so the item
      // is never observable at its final status without its post or its assets.
      // `armedAt` rides along because arming is when the media-ready window
      // STARTS. See the armedAt describe below.
      data: {
        socialPostId: 'post-1',
        generatedAssetIds: ['a1', 'a2'],
        status: 'SCHEDULED',
        armedAt: expect.any(Date),
      },
    });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith({
      workspaceId: WS,
      kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
      runAt: SLOT,
      payload: { itemId: ITEM, workspaceId: WS },
      // The same key `approveItem` uses, so a human approving an already-armed
      // item collapses onto the pending job rather than queueing a second publish.
      dedupKey: confirmDedup(ITEM),
    });
  });

  it('SEMI_AUTO: NEEDS_APPROVAL, and the gate is armed anyway', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    await svc.arm({ workspaceId: WS, itemId: ITEM, automationMode: 'SEMI_AUTO', scheduledFor: SLOT });
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { status: 'NEEDS_APPROVAL', armedAt: expect.any(Date) },
    });
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(1);
  });

  it('APPROVAL: NEEDS_APPROVAL and NO job — the gate stays for a human to arm', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    await svc.arm({ workspaceId: WS, itemId: ITEM, automationMode: 'APPROVAL', scheduledFor: SLOT });
    // No `armedAt`: nothing was armed, so no window has opened. Stamping one
    // here would date a wait that never started.
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { status: 'NEEDS_APPROVAL' },
    });
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });
});

/**
 * THE HUMAN DOOR, through the same implementation.
 *
 * `SocialCampaignsService.approveItem` kept its own status + schedule + dedup
 * triple after this service was extracted. That copy is what would have missed
 * the `armedAt` stamp below — and an arming door that does not stamp it hands
 * `confirmItem` a window measured from a calendar slot that may be hours past,
 * which is how a caption publishes with no video.
 */
describe('CampaignItemArmingService.armApproved — a person clicked Approve', () => {
  it('SCHEDULED, armed at the slot, stamped, and the row comes back', async () => {
    const { svc, prisma, scheduledJobs } = harness();
    prisma.socialCampaignItem.update.mockResolvedValue({ id: ITEM, status: 'SCHEDULED' });

    const row = await svc.armApproved({ workspaceId: WS, itemId: ITEM, scheduledFor: SLOT });

    expect(row).toEqual({ id: ITEM, status: 'SCHEDULED' });
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { status: 'SCHEDULED', armedAt: expect.any(Date) },
    });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith({
      workspaceId: WS,
      kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
      runAt: SLOT,
      payload: { itemId: ITEM, workspaceId: WS },
      // The SAME dedup key autonomy uses: approving an already-armed item
      // collapses onto the pending job instead of queueing a second publish.
      dedupKey: confirmDedup(ITEM),
    });
  });
});

/**
 * `armedAt` IS THE START OF THE MEDIA-READY WINDOW.
 *
 * The confirm gate waits, bounded, for still-generating clips. It measured that
 * bound from `scheduledFor` — a calendar slot — on the assumption that arming
 * happens before the slot. The content-concept producer broke that assumption:
 * it buys its clips at production time and reschedules itself for up to an hour
 * while the generation queue is full, so a FULL_AUTO item can be armed long
 * AFTER its slot with every clip still QUEUED. Stamping the moment of arming is
 * what lets the gate wait from when the waiting actually began.
 */
describe('CampaignItemArmingService — when the window opens', () => {
  it('stamps armedAt at the moment of arming, not at the slot', async () => {
    const { svc, prisma } = harness();
    const before = Date.now();
    await svc.arm({ workspaceId: WS, itemId: ITEM, automationMode: 'FULL_AUTO', scheduledFor: SLOT });
    const stamped = prisma.socialCampaignItem.update.mock.calls[0][0].data.armedAt as Date;

    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    // Emphatically NOT the slot: an item armed an hour past its slot must get a
    // full window, not a window that expired before it opened.
    expect(stamped.getTime()).not.toBe(SLOT.getTime());
  });
});
