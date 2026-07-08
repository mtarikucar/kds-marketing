import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CampaignsService, CAMPAIGN_BATCH_KIND, CAMPAIGN_LAUNCH_KIND } from './campaigns.service';

/**
 * Audience resolution + launch. The audience where must always pin the
 * workspace + opt-in + reachability, accept only whitelisted lead filter
 * fields, and launch must freeze recipients + flip to SENDING + kick a batch
 * (and refuse an empty audience).
 */
describe('CampaignsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let scheduledJobs: { schedule: jest.Mock; cancel: jest.Mock };
  let entitlements: { getEffective: jest.Mock };
  let svc: CampaignsService;

  beforeEach(() => {
    prisma = {
      campaign: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { findMany: jest.fn().mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]) },
      campaignRecipient: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    scheduledJobs = { schedule: jest.fn().mockResolvedValue('job'), cancel: jest.fn().mockResolvedValue(true) };
    // Default: entitled to sms (matches every plan block — no regression).
    entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { sms: true } }) };
    svc = new CampaignsService(prisma as any, scheduledJobs as any, entitlements as any);
  });

  describe('buildAudienceWhere', () => {
    it('EMAIL pins workspace + opt-in + a present email', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', []);
      expect(w.workspaceId).toBe(WS);
      expect(w.emailOptOut).toBe(false);
      expect(w.email).toEqual({ not: null });
    });

    it('WHATSAPP requires a whatsapp or phone', () => {
      const w: any = svc.buildAudienceWhere(WS, 'WHATSAPP', []);
      expect(w.waOptOut).toBe(false);
      expect(w.OR).toEqual([{ whatsapp: { not: null } }, { phone: { not: null } }]);
    });

    it('maps whitelisted filters and ignores unknown fields', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [
        { field: 'lead.status', op: 'eq', value: 'NEW' },
        { field: 'lead.secretColumn', op: 'eq', value: 'x' }, // not whitelisted → ignored
      ]);
      expect(w.status).toBe('NEW');
      expect(w.secretColumn).toBeUndefined();
    });

    // A scalar op (eq/neq/gte/lte) with an ARRAY value would compile to
    // `{ status: ['NEW','CONTACTED'] }` — an invalid Prisma filter that 500s when
    // the audience is materialized (recipient count / send). The `in` case
    // already guards Array.isArray; the scalar ops must too. Drop the malformed
    // leaf rather than emit a poisoned where.
    it('skips a scalar op whose value is an array (avoids a Prisma 500)', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [
        { field: 'lead.status', op: 'eq', value: ['NEW', 'CONTACTED'] },
        { field: 'lead.city', op: 'gte', value: ['a', 'b'] },
        { field: 'lead.region', op: 'neq', value: ['X', 'Y'] },
        { field: 'lead.businessType', op: 'eq', value: 'CAFE' }, // a valid scalar still applies
      ]);
      expect(w.status).toBeUndefined();
      expect(w.city).toBeUndefined();
      expect(w.region).toBeUndefined();
      expect(w.businessType).toBe('CAFE');
    });
  });

  describe('launch', () => {
    it('materializes recipients, flips to SENDING, and kicks a batch', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi see https://x.com', audienceFilter: [] });
      const res = await svc.launch(WS, 'c1');
      expect(res.recipients).toBe(2);
      expect(prisma.campaignRecipient.createMany).toHaveBeenCalled();
      const update = prisma.campaign.update.mock.calls[0][0].data;
      expect(update.status).toBe('SENDING');
      expect(update.links).toEqual(['https://x.com']);
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'campaign.batch', dedupKey: 'c1' }),
      );
    });

    it('refuses an empty audience', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'x', audienceFilter: [] });
      prisma.lead.findMany.mockResolvedValue([]);
      await expect(svc.launch(WS, 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to re-launch a SENDING campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', body: 'x', audienceFilter: [] });
      await expect(svc.launch(WS, 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns every recipient a variant key when A/B is enabled', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi', bodyHtml: null, abEnabled: true, audienceFilter: [] });
      prisma.campaignVariant = {
        findMany: jest.fn().mockResolvedValue([
          { key: 'A', weight: 1, body: 'Hi A', bodyHtml: null },
          { key: 'B', weight: 1, body: 'Hi B', bodyHtml: null },
        ]),
      };
      await svc.launch(WS, 'c1');
      const rows = prisma.campaignRecipient.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(['A', 'B']).toContain(row.variantKey);
    });

    it('leaves variantKey null when A/B is off', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi', abEnabled: false, audienceFilter: [] });
      await svc.launch(WS, 'c1');
      const rows = prisma.campaignRecipient.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.variantKey === null)).toBe(true);
    });

    // Task 8b: a future scheduledAt defers the actual send — freeze now, but
    // flip to SCHEDULED (not SENDING) and queue the `campaign.launch` job for
    // scheduledAt instead of kicking a batch right away.
    describe('with a scheduledAt', () => {
      it('a FUTURE scheduledAt freezes the audience but flips to SCHEDULED and queues campaign.launch (no batch kick)', async () => {
        const scheduledAt = new Date(Date.now() + 60 * 60 * 1000); // 1h out
        prisma.campaign.findFirst.mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi', audienceFilter: [], scheduledAt,
        });

        const res = await svc.launch(WS, 'c1');

        // Audience still frozen exactly like the immediate path.
        expect(prisma.campaignRecipient.createMany).toHaveBeenCalled();
        const update = prisma.campaign.update.mock.calls[0][0].data;
        expect(update.status).toBe('SCHEDULED');
        expect(update.startedAt).toBeUndefined();
        // The `campaign.launch` job is queued for scheduledAt — not a batch kick.
        expect(scheduledJobs.schedule).toHaveBeenCalledWith(
          expect.objectContaining({ kind: CAMPAIGN_LAUNCH_KIND, dedupKey: 'c1', runAt: scheduledAt }),
        );
        expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
          expect.objectContaining({ kind: CAMPAIGN_BATCH_KIND }),
        );
        expect(res).toEqual(expect.objectContaining({ message: 'Campaign scheduled', recipients: 2, scheduledAt }));
      });

      it('a scheduledAt within the 30s tolerance sends immediately (SENDING + batch kick), not SCHEDULED', async () => {
        const almostNow = new Date(Date.now() + 5_000); // well under the 30s tolerance
        prisma.campaign.findFirst.mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi', audienceFilter: [], scheduledAt: almostNow,
        });

        await svc.launch(WS, 'c1');

        const update = prisma.campaign.update.mock.calls[0][0].data;
        expect(update.status).toBe('SENDING');
        expect(scheduledJobs.schedule).toHaveBeenCalledWith(
          expect.objectContaining({ kind: CAMPAIGN_BATCH_KIND, dedupKey: 'c1' }),
        );
      });

      it('a past scheduledAt (e.g. a stale SCHEDULED campaign re-launched) sends immediately', async () => {
        const past = new Date(Date.now() - 60_000);
        prisma.campaign.findFirst.mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL', body: 'Hi', audienceFilter: [], scheduledAt: past,
        });

        await svc.launch(WS, 'c1');

        const update = prisma.campaign.update.mock.calls[0][0].data;
        expect(update.status).toBe('SENDING');
      });

      it('an absent scheduledAt keeps the existing immediate-send behavior', async () => {
        prisma.campaign.findFirst.mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi', audienceFilter: [], scheduledAt: null,
        });

        await svc.launch(WS, 'c1');

        const update = prisma.campaign.update.mock.calls[0][0].data;
        expect(update.status).toBe('SENDING');
      });
    });
  });

  describe('cancel', () => {
    it('cancels both the queued campaign.launch job AND the batch job (by dedupKey=campaignId) and flips SCHEDULED → CANCELLED', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SCHEDULED' });
      const res = await svc.cancel(WS, 'c1');
      expect(scheduledJobs.cancel).toHaveBeenCalledWith(CAMPAIGN_BATCH_KIND, 'c1');
      expect(scheduledJobs.cancel).toHaveBeenCalledWith(CAMPAIGN_LAUNCH_KIND, 'c1');
      expect(prisma.campaign.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { status: 'CANCELLED' } });
      expect(res).toEqual({ message: 'Campaign cancelled' });
    });

    it('refuses to cancel a SENDING campaign (409) — pause covers that', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING' });
      await expect(svc.cancel(WS, 'c1')).rejects.toBeInstanceOf(ConflictException);
      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
    });

    it('refuses to re-cancel an already-CANCELLED campaign (409, not a silent no-op)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'CANCELLED' });
      await expect(svc.cancel(WS, 'c1')).rejects.toBeInstanceOf(ConflictException);
      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
    });

    it('404s when the campaign does not exist in this workspace', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(svc.cancel(WS, 'missing')).rejects.toThrow('Campaign not found');
    });
  });

  describe('setVariants', () => {
    beforeEach(() => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', status: 'DRAFT' });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      prisma.campaignVariant = {
        deleteMany: jest.fn(), createMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      };
      prisma.campaign.updateMany = jest.fn();
    });

    it('rejects duplicate variant keys', async () => {
      await expect(svc.setVariants(WS, 'c1', { variants: [{ key: 'A', body: 'x' }, { key: 'A', body: 'y' }] }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an out-of-range weight', async () => {
      await expect(svc.setVariants(WS, 'c1', { variants: [{ key: 'A', weight: 0, body: 'x' }] }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('replaces variants in one transaction (delete + create + campaign update)', async () => {
      await svc.setVariants(WS, 'c1', { abEnabled: true, variants: [{ key: 'A', body: 'x' }] });
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3);
    });

    it('refuses to edit variants on a launched campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', status: 'SENDING' });
      await expect(svc.setVariants(WS, 'c1', { variants: [{ key: 'A', body: 'x' }] }))
        .rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('subject clear parity (nullable-field normalization)', () => {
    beforeEach(() => {
      prisma.campaign.create = jest.fn().mockResolvedValue({ id: 'c1' });
    });

    it('create normalizes an empty subject to null (not "")', async () => {
      await svc.create(WS, { name: 'N', channel: 'EMAIL', subject: '', body: 'Hi' });
      expect(prisma.campaign.create.mock.calls[0][0].data.subject).toBeNull();
    });

    it('update clears the subject when edited to empty (maps "" → null so it persists)', async () => {
      // The bug: '' persisted as '' (or, when the FE sent undefined, the old subject
      // survived). An emptied subject must normalize to null like bodyHtml/template.
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT' });
      await svc.update(WS, 'c1', { subject: '' });
      expect(prisma.campaign.update.mock.calls[0][0].data.subject).toBeNull();
    });

    it('update keeps a non-empty subject as-is', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT' });
      await svc.update(WS, 'c1', { subject: 'Spring sale' });
      expect(prisma.campaign.update.mock.calls[0][0].data.subject).toBe('Spring sale');
    });
  });

  // Task 8b: a SCHEDULED campaign already has its `campaign.launch` job queued
  // (audience frozen at the original launch() call). Editing scheduledAt must
  // move that job, not just the DB column.
  describe('update — reschedule a SCHEDULED campaign', () => {
    it('reschedules the queued campaign.launch job to the new scheduledAt (cancel + schedule)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SCHEDULED' });
      const newScheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

      await svc.update(WS, 'c1', { scheduledAt: newScheduledAt.toISOString() });

      expect(scheduledJobs.cancel).toHaveBeenCalledWith(CAMPAIGN_LAUNCH_KIND, 'c1');
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: CAMPAIGN_LAUNCH_KIND, dedupKey: 'c1', runAt: newScheduledAt }),
      );
      // Only the DB column update, not a second status-revert update.
      expect(prisma.campaign.update).toHaveBeenCalledTimes(1);
    });

    it('clearing scheduledAt on a SCHEDULED campaign cancels the job and reverts status to DRAFT (no orphaned SCHEDULED-with-nothing-queued)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SCHEDULED' });

      await svc.update(WS, 'c1', { scheduledAt: '' });

      expect(scheduledJobs.cancel).toHaveBeenCalledWith(CAMPAIGN_LAUNCH_KIND, 'c1');
      expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(expect.objectContaining({ kind: CAMPAIGN_LAUNCH_KIND }));
      // Two writes: the scheduledAt=null column update, then the status revert.
      expect(prisma.campaign.update).toHaveBeenCalledTimes(2);
      expect(prisma.campaign.update.mock.calls[1][0]).toEqual({ where: { id: 'c1' }, data: { status: 'DRAFT' } });
    });

    it('does NOT touch any job when a DRAFT campaign edits scheduledAt (nothing queued yet)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT' });

      await svc.update(WS, 'c1', { scheduledAt: new Date(Date.now() + 60_000).toISOString() });

      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('does NOT touch any job when a SCHEDULED campaign is edited without changing scheduledAt', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SCHEDULED' });

      await svc.update(WS, 'c1', { name: 'New name' });

      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });
  });

  // Split off `conversationAi` for the NetGSM SMS v2 program: an SMS-channel
  // campaign now requires its own `sms` feature; EMAIL/WHATSAPP are unaffected
  // (they never check entitlements here — `campaigns` at the controller
  // already gates the whole surface).
  describe('create — SMS feature gate', () => {
    beforeEach(() => {
      prisma.campaign.create = jest.fn().mockResolvedValue({ id: 'c1' });
    });

    it('blocks an SMS campaign when the workspace lacks the sms feature', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { sms: false } });
      await expect(
        svc.create(WS, { name: 'N', channel: 'SMS', body: 'Hi' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.campaign.create).not.toHaveBeenCalled();
    });

    it('allows an SMS campaign when the workspace has the sms feature', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { sms: true } });
      await svc.create(WS, { name: 'N', channel: 'SMS', body: 'Hi' });
      expect(prisma.campaign.create).toHaveBeenCalled();
    });

    it('never checks entitlements for an EMAIL or WHATSAPP campaign', async () => {
      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi' });
      await svc.create(WS, { name: 'N', channel: 'WHATSAPP', body: 'Hi' });
      expect(entitlements.getEffective).not.toHaveBeenCalled();
    });
  });
});
