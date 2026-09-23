import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CampaignsService, CAMPAIGN_BATCH_KIND, CAMPAIGN_LAUNCH_KIND, CAMPAIGN_AB_DECIDE_KIND } from './campaigns.service';

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
  let segmentCompiler: { compile: jest.Mock };
  let svc: CampaignsService;

  let iysEmail: any;
  beforeEach(() => {
    prisma = {
      campaign: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { findMany: jest.fn().mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]) },
      campaignRecipient: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      campaignVariant: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      emailTemplate: { findMany: jest.fn().mockResolvedValue([]) },
      segment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    scheduledJobs = { schedule: jest.fn().mockResolvedValue('job'), cancel: jest.fn().mockResolvedValue(true) };
    // Default: entitled to sms (matches every plan block — no regression).
    entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { sms: true } }) };
    segmentCompiler = { compile: jest.fn().mockReturnValue({ AND: [{ workspaceId: WS }] }) };
    // Unarmed, which is every workspace today: the composer's TİCARİ option
    // stays coerced to BİLGİLENDİRME exactly as it was before the port existed.
    iysEmail = { readiness: jest.fn().mockResolvedValue({ armed: false, configured: false, gap: 'NOT_ARMED', messageKey: 'compliance.iysEposta.notArmed' }) };
    svc = new CampaignsService(
      prisma as any,
      scheduledJobs as any,
      entitlements as any,
      segmentCompiler as any,
      iysEmail as any,
    );
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

    /**
     * `id` was added to the whitelist so a ONE-RECIPIENT campaign is
     * expressible — that is what makes the MCP `jeeta.send_email` tool a
     * compliant send rather than a raw SMTP call. It must NARROW the audience
     * and weaken nothing: the opt-out, deliverability and tombstone guards all
     * still have to be on the resulting where.
     */
    it('id narrows to a single lead without loosening any guard', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'id', op: 'eq', value: 'lead-9' }]);
      expect(w.id).toBe('lead-9');
      expect(w.workspaceId).toBe(WS);
      expect(w.emailOptOut).toBe(false);
      expect(w.email).toEqual({ not: null });
      expect(w.emailBouncedAt).toBeNull();
      expect(w.emailVerifiedStatus).toEqual({ not: 'INVALID' });
      expect(w.deletedAt).toBeNull();
      expect(w.mergedIntoId).toBeNull();
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
    /**
     * `mcp-filter-rewrite`: every value that reaches here from a form is a
     * STRING, and "false" is truthy — so "has no email" compiled to "has an
     * email" and the campaign went to exactly the people it was meant to skip.
     */
    it('exists:false means IS NULL, however it was spelled', () => {
      for (const value of [false, 'false', 0, '0', undefined, null]) {
        const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'city', op: 'exists', value }]);
        expect(w.city).toBeNull();
      }
      for (const value of [true, 'true', 1, '1']) {
        const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'city', op: 'exists', value }]);
        expect(w.city).toEqual({ not: null });
      }
    });

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

  describe('performance', () => {
    it('reads the narrow stats-relevant select, workspace-scoped, and returns it as-is', async () => {
      const row = {
        id: 'camp1',
        name: 'Summer blast',
        channel: 'SMS',
        status: 'SENDING',
        stats: { recipients: 10, sent: 8, failed: 1, skipped: 1, opened: 3, clicked: 1, unsubscribed: 0 },
        scheduledAt: null,
        startedAt: new Date('2026-07-01'),
        completedAt: null,
      };
      prisma.campaign.findFirst.mockResolvedValue(row);

      const out = await svc.performance(WS, 'camp1');

      expect(prisma.campaign.findFirst).toHaveBeenCalledWith({
        where: { id: 'camp1', workspaceId: WS },
        select: {
          id: true,
          name: true,
          channel: true,
          status: true,
          stats: true,
          scheduledAt: true,
          startedAt: true,
          completedAt: true,
        },
      });
      // Must actually surface `stats` (the whole point of this read) rather
      // than a select that silently drops it.
      expect(out.stats).toEqual(row.stats);
      expect(out).toEqual(row);
    });

    it('throws NotFoundException for a campaign outside the workspace', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(svc.performance(WS, 'camp1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('launch', () => {
    it('materializes recipients, flips to SENDING, and kicks a batch', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi see https://x.com', audienceFilter: [] });
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

    /**
     * `prelaunch-safety`: the sender defaults a missing subject to "Update",
     * so an EMAIL campaign could blast thousands of people a mail whose subject
     * line said nothing. Launch is the one chokepoint every caller passes —
     * the composer, the MCP tool and a raw API call.
     */
    it('refuses an EMAIL campaign with no subject, before it touches the audience', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: '  ', body: 'x', audienceFilter: [] });
      await expect(svc.launch(WS, 'c1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lead.findMany).not.toHaveBeenCalled();
    });

    it('does not ask an SMS campaign for a subject', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'SMS', subject: null, body: 'x', audienceFilter: [] });
      await expect(svc.launch(WS, 'c1')).resolves.toEqual(expect.objectContaining({ recipients: 2 }));
    });

    it('refuses an empty audience', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'x', audienceFilter: [] });
      prisma.lead.findMany.mockResolvedValue([]);
      await expect(svc.launch(WS, 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to re-launch a SENDING campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SENDING', channel: 'EMAIL', body: 'x', audienceFilter: [] });
      await expect(svc.launch(WS, 'c1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns every recipient a variant key when A/B is enabled', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', bodyHtml: null, abEnabled: true, audienceFilter: [] });
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

    it('WINNER mode with an audience too small to hold back (leads <= variants) falls back to SPLIT — no decide job, no HOLD', async () => {
      // 2 default leads, 3 variants → can't test ≥1/variant AND hold back ≥1.
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', bodyHtml: null,
        abEnabled: true, abMode: 'WINNER', abTestPercent: 20, audienceFilter: [],
      });
      prisma.campaignVariant = {
        findMany: jest.fn().mockResolvedValue([
          { key: 'A', weight: 1, body: 'a', bodyHtml: null },
          { key: 'B', weight: 1, body: 'b', bodyHtml: null },
          { key: 'C', weight: 1, body: 'c', bodyHtml: null },
        ]),
      };

      await svc.launch(WS, 'c1');

      // No pointless winner phase: no ab-decide job, and every recipient is a
      // PENDING variant send (none HELD).
      expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: CAMPAIGN_AB_DECIDE_KIND }),
      );
      const rows = prisma.campaignRecipient.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.status !== 'HOLD' && ['A', 'B', 'C'].includes(r.variantKey))).toBe(true);
    });

    it('leaves variantKey null when A/B is off', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', abEnabled: false, audienceFilter: [] });
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
          id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', audienceFilter: [], scheduledAt,
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
          id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', audienceFilter: [], scheduledAt: almostNow,
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
          id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL', subject: 'Konu', body: 'Hi', audienceFilter: [], scheduledAt: past,
        });

        await svc.launch(WS, 'c1');

        const update = prisma.campaign.update.mock.calls[0][0].data;
        expect(update.status).toBe('SENDING');
      });

      it('an absent scheduledAt keeps the existing immediate-send behavior', async () => {
        prisma.campaign.findFirst.mockResolvedValue({
          id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', audienceFilter: [], scheduledAt: null,
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

    // A SCHEDULED campaign already froze recipients WITH their variantKey — a
    // variant edit would leave them pointing at a removed key (silently
    // degraded to control), so it reverts to DRAFT + drops the frozen rows.
    it('reverts a SCHEDULED campaign to DRAFT and drops frozen recipients on a variant edit', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });
      await svc.setVariants(WS, 'c1', { abEnabled: true, variants: [{ key: 'B', body: 'x' }] });
      expect(scheduledJobs.cancel).toHaveBeenCalledWith('campaign.launch', 'c1');
      expect(prisma.campaignRecipient.deleteMany).toHaveBeenCalledWith({ where: { campaignId: 'c1', workspaceId: WS } });
      // The status-DRAFT revert is the LAST campaign.updateMany call.
      const lastUpdate = prisma.campaign.updateMany.mock.calls.at(-1)[0];
      expect(lastUpdate.data).toMatchObject({ status: 'DRAFT' });
    });

    it('does NOT revert a still-DRAFT campaign (nothing frozen yet)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', status: 'DRAFT' });
      await svc.setVariants(WS, 'c1', { variants: [{ key: 'A', body: 'x' }] });
      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('update — SCHEDULED audience change re-freeze safety', () => {
    it('reverts SCHEDULED → DRAFT and drops frozen recipients when the audience filter changes', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL', audienceFilter: [{ field: 'city', op: 'eq', value: 'Izmir' }],
      });
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });
      const out: any = await svc.update(WS, 'c1', { audienceFilter: [{ field: 'city', op: 'eq', value: 'Ankara' }] });
      expect(scheduledJobs.cancel).toHaveBeenCalledWith('campaign.launch', 'c1');
      expect(prisma.campaignRecipient.deleteMany).toHaveBeenCalledWith({ where: { campaignId: 'c1', workspaceId: WS } });
      expect(out.status).toBe('DRAFT');
      // Reverted → it must NOT re-queue the launch job.
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('an UNCHANGED audience filter on a SCHEDULED campaign does not revert (deep-equal, not identity)', async () => {
      const filter = [{ field: 'city', op: 'eq', value: 'Izmir' }];
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL', audienceFilter: filter, scheduledAt: new Date(Date.now() + 86_400_000),
      });
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });
      await svc.update(WS, 'c1', { audienceFilter: [{ field: 'city', op: 'eq', value: 'Izmir' }], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
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
    it('reschedules the queued campaign.launch job to the new scheduledAt via schedule()\'s dedup collapse (no explicit cancel needed)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SCHEDULED' });
      const newScheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

      await svc.update(WS, 'c1', { scheduledAt: newScheduledAt.toISOString() });

      // schedule()'s dedupKey lookup updates the existing PENDING row's runAt in
      // place, so a cancel-then-create isn't needed for the reschedule-to-future path.
      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: CAMPAIGN_LAUNCH_KIND, dedupKey: 'c1', runAt: newScheduledAt }),
      );
      // Only the DB column update, not a second status-revert update.
      expect(prisma.campaign.update).toHaveBeenCalledTimes(1);
    });

    it('clearing scheduledAt on a SCHEDULED campaign cancels the job and reverts status to DRAFT (no orphaned SCHEDULED-with-nothing-queued)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'SCHEDULED' });

      await svc.update(WS, 'c1', { scheduledAt: '' });

      // The revert must also drop the frozen recipients, exactly like its two
      // sibling revert branches — otherwise a later launch() mails the UNION of
      // the old frozen audience and the new one (stale-recipients).
      expect(prisma.campaignRecipient.deleteMany).toHaveBeenCalledWith({
        where: { campaignId: 'c1', workspaceId: WS },
      });
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

  // NetGSM Phase 5 Task 2: VOICE campaigns require the `voiceCampaigns`
  // feature (same shape of gate as SMS above) AND a voiceConfig carrying
  // msg or audioid (voicesms/send accepts exactly one of them).
  describe('create/update — VOICE campaigns', () => {
    beforeEach(() => {
      prisma.campaign.create = jest.fn().mockResolvedValue({ id: 'c1' });
    });

    it('blocks a VOICE campaign when the workspace lacks the voiceCampaigns feature', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { voiceCampaigns: false } });
      await expect(
        svc.create(WS, { name: 'N', channel: 'VOICE', body: 'desc', voiceConfig: { msg: 'Merhaba' } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.campaign.create).not.toHaveBeenCalled();
    });

    it('requires voiceConfig with msg or audioid — rejects when neither is set', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { voiceCampaigns: true } });
      await expect(
        svc.create(WS, { name: 'N', channel: 'VOICE', body: 'desc', voiceConfig: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.create(WS, { name: 'N', channel: 'VOICE', body: 'desc' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.campaign.create).not.toHaveBeenCalled();
    });

    it('accepts a VOICE campaign with only msg (TTS text)', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { voiceCampaigns: true } });
      await svc.create(WS, { name: 'N', channel: 'VOICE', body: 'desc', voiceConfig: { msg: 'Merhaba' } });
      expect(prisma.campaign.create).toHaveBeenCalled();
      expect(prisma.campaign.create.mock.calls[0][0].data.voiceConfig).toEqual({ msg: 'Merhaba' });
    });

    it('accepts a VOICE campaign with only audioid (no msg)', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { voiceCampaigns: true } });
      await svc.create(WS, { name: 'N', channel: 'VOICE', body: 'desc', voiceConfig: { audioid: 'aud-1' } });
      expect(prisma.campaign.create).toHaveBeenCalled();
      expect(prisma.campaign.create.mock.calls[0][0].data.voiceConfig).toEqual({ audioid: 'aud-1' });
    });

    it('applies iysMessageType TICARI for a VOICE campaign (same as SMS)', async () => {
      entitlements.getEffective.mockResolvedValue({ features: { voiceCampaigns: true } });
      await svc.create(WS, {
        name: 'N', channel: 'VOICE', body: 'desc', voiceConfig: { msg: 'Merhaba' }, iysMessageType: 'TICARI',
      });
      expect(prisma.campaign.create.mock.calls[0][0].data.iysMessageType).toBe('TICARI');
    });

    it('never sets voiceConfig on a non-VOICE campaign even if one is passed', async () => {
      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi', voiceConfig: { msg: 'stray' } } as any);
      expect(prisma.campaign.create.mock.calls[0][0].data.voiceConfig).toBe(Prisma.JsonNull);
    });

    it('update: re-validates voiceConfig on an existing VOICE campaign and rejects clearing both msg and audioid', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'VOICE' });
      await expect(svc.update(WS, 'c1', { voiceConfig: {} })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update: accepts a valid voiceConfig edit on a VOICE campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'VOICE' });
      await svc.update(WS, 'c1', { voiceConfig: { audioid: 'aud-2' } });
      expect(prisma.campaign.update.mock.calls[0][0].data.voiceConfig).toEqual({ audioid: 'aud-2' });
    });

    it('update: ignores a voiceConfig edit on a non-VOICE campaign (no cross-field validation, no write)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'SMS' });
      await svc.update(WS, 'c1', { voiceConfig: {} });
      expect(prisma.campaign.update.mock.calls[0][0].data.voiceConfig).toBeUndefined();
    });

    it('update: applies iysMessageType TICARI for an existing VOICE campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'VOICE' });
      await svc.update(WS, 'c1', { iysMessageType: 'TICARI' });
      expect(prisma.campaign.update.mock.calls[0][0].data.iysMessageType).toBe('TICARI');
    });

    /**
     * EMAIL was coerced to BİLGİLENDİRME unconditionally, which was right while
     * nothing checked İYS for email at all. Now the BULK gate does — but only
     * for a workspace that armed it, so the unlock has to be conditional on the
     * same readiness the gate reads (`tr-commercial-compliance`).
     */
    it('still coerces an EMAIL campaign to BILGILENDIRME while İYS EPOSTA is unarmed', async () => {
      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi', iysMessageType: 'TICARI' });
      expect(prisma.campaign.create.mock.calls[0][0].data.iysMessageType).toBe('BILGILENDIRME');
    });

    it('lets an armed workspace mark an EMAIL campaign TICARI', async () => {
      iysEmail.readiness.mockResolvedValue({ armed: true, configured: true, gap: null, messageKey: null });
      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi', iysMessageType: 'TICARI' });
      expect(prisma.campaign.create.mock.calls[0][0].data.iysMessageType).toBe('TICARI');
      expect(iysEmail.readiness).toHaveBeenCalledWith(WS);
    });

    it('does not ask İYS anything when the campaign was not marked TICARI', async () => {
      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi' });
      expect(iysEmail.readiness).not.toHaveBeenCalled();
      expect(prisma.campaign.create.mock.calls[0][0].data.iysMessageType).toBe('BILGILENDIRME');
    });

    it('keeps coercing an ARMED-but-unconfigured workspace — a gate that cannot answer must not mark mail commercial', async () => {
      iysEmail.readiness.mockResolvedValue({ armed: true, configured: false, gap: 'NO_CREDENTIALS', messageKey: 'compliance.iysEposta.noCredentials' });
      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi', iysMessageType: 'TICARI' });
      expect(prisma.campaign.create.mock.calls[0][0].data.iysMessageType).toBe('BILGILENDIRME');
    });

    it('update: the same unlock applies to an existing EMAIL campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL' });
      iysEmail.readiness.mockResolvedValue({ armed: true, configured: true, gap: null, messageKey: null });
      await svc.update(WS, 'c1', { iysMessageType: 'TICARI' });
      expect(prisma.campaign.update.mock.calls[0][0].data.iysMessageType).toBe('TICARI');
    });

    it('update: an unarmed workspace still cannot mark an EMAIL campaign TICARI', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL' });
      await svc.update(WS, 'c1', { iysMessageType: 'TICARI' });
      expect(prisma.campaign.update.mock.calls[0][0].data.iysMessageType).toBe('BILGILENDIRME');
    });

    it('never asks İYS about a WHATSAPP campaign — the rule is channel-bound', async () => {
      iysEmail.readiness.mockResolvedValue({ armed: true, configured: true, gap: null, messageKey: null });
      await svc.create(WS, { name: 'N', channel: 'WHATSAPP', body: 'Hi', iysMessageType: 'TICARI' });
      expect(iysEmail.readiness).not.toHaveBeenCalled();
      expect(prisma.campaign.create.mock.calls[0][0].data.iysMessageType).toBe('BILGILENDIRME');
    });

    it('buildAudienceWhere VOICE requires a phone and reuses the smsOptOut proxy', () => {
      const w: any = svc.buildAudienceWhere(WS, 'VOICE', []);
      expect(w.smsOptOut).toBe(false);
      expect(w.phone).toEqual({ not: null });
    });
  });

  // audience-targeting: a tag/list audience is expressible, enum-ish values are
  // matched case-insensitively by NORMALIZING them (never by Prisma's
  // `mode:'insensitive'`, which is ILIKE and would turn an `id` filter's
  // `%`/`_` into wildcards — i.e. "email this one lead" into a blast).
  describe('buildAudienceWhere — tags and enum casing', () => {
    it('targets a tag through AND, not a key assignment', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'tag', op: 'eq', value: 'tag-1' }]);
      expect(w.AND).toEqual([{ tags: { some: { tagId: 'tag-1' } } }]);
    });

    it('excludes a tag with neq', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'tag', op: 'neq', value: 'tag-1' }]);
      expect(w.AND).toEqual([{ tags: { none: { tagId: 'tag-1' } } }]);
    });

    // Two tag rules on one key would silently collide (last wins) — the reason
    // they go into an AND array rather than onto `where.tags`.
    it('keeps BOTH tag rules when two are given', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [
        { field: 'tag', op: 'eq', value: 'fuar-2026' },
        { field: 'tag', op: 'neq', value: 'musteri' },
      ]);
      expect(w.AND).toEqual([
        { tags: { some: { tagId: 'fuar-2026' } } },
        { tags: { none: { tagId: 'musteri' } } },
      ]);
    });

    it('does not add an empty AND when no tag rule is given', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'city', op: 'eq', value: 'Izmir' }]);
      expect(w.AND).toBeUndefined();
    });

    it('uppercases the enum-ish fields so typing "new" still matches', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [
        { field: 'lead.status', op: 'eq', value: 'new' },
        { field: 'lead.priority', op: 'neq', value: 'low' },
        { field: 'lead.source', op: 'in', value: ['ads', 'referral'] },
        { field: 'lead.businessType', op: 'eq', value: 'cafe' },
      ]);
      expect(w.status).toBe('NEW');
      expect(w.priority).toEqual({ not: 'LOW' });
      expect(w.source).toEqual({ in: ['ADS', 'REFERRAL'] });
      expect(w.businessType).toBe('CAFE');
    });

    // Free text is NOT an enum: a city or a business name keeps the operator's
    // casing (contains is already insensitive), and `id` is never touched.
    it('leaves free-text fields and id exactly as given', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [
        { field: 'lead.city', op: 'eq', value: 'Izmir' },
        { field: 'id', op: 'eq', value: 'lead-9' },
      ]);
      expect(w.city).toBe('Izmir');
      expect(w.id).toBe('lead-9');
    });

    // segmentId needs a DB read, so it is resolved by resolveAudienceWhere —
    // buildAudienceWhere stays sync and must drop it rather than emit a
    // `where.segmentId` that Prisma would 500 on.
    it('drops segmentId (resolved asynchronously, never a lead column)', () => {
      const w: any = svc.buildAudienceWhere(WS, 'EMAIL', [{ field: 'segmentId', op: 'eq', value: 'seg-1' }]);
      expect(w.segmentId).toBeUndefined();
      expect(w.AND).toBeUndefined();
    });
  });

  // The one source of truth the audience-preview endpoint shares with launch(),
  // so a preview and a send can never disagree.
  describe('resolveAudienceWhere — segments', () => {
    it('merges a compiled segment under AND, leaving the channel reachability OR intact', async () => {
      prisma.segment.findFirst.mockResolvedValue({ id: 'seg-1', definition: { op: 'and', children: [] } });
      segmentCompiler.compile.mockReturnValue({ AND: [{ workspaceId: WS }, { status: 'WON' }] });

      const w: any = await svc.resolveAudienceWhere(WS, 'WHATSAPP', [
        { field: 'segmentId', op: 'eq', value: 'seg-1' },
      ]);

      // Tenant-scoped read, exactly like SegmentsService.getOwned.
      expect(prisma.segment.findFirst).toHaveBeenCalledWith({
        where: { id: 'seg-1', workspaceId: WS },
        select: { definition: true },
      });
      expect(w.OR).toEqual([{ whatsapp: { not: null } }, { phone: { not: null } }]);
      expect(w.AND).toEqual([{ AND: [{ workspaceId: WS }, { status: 'WON' }] }]);
    });

    it('refuses a segment from another workspace instead of silently widening the audience', async () => {
      prisma.segment.findFirst.mockResolvedValue(null);
      await expect(
        svc.resolveAudienceWhere(WS, 'EMAIL', [{ field: 'segmentId', op: 'eq', value: 'seg-x' }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not touch the database when no segment is targeted', async () => {
      const w: any = await svc.resolveAudienceWhere(WS, 'EMAIL', [{ field: 'lead.status', op: 'eq', value: 'NEW' }]);
      expect(prisma.segment.findFirst).not.toHaveBeenCalled();
      expect(w.status).toBe('NEW');
    });
  });

  // stale-recipients + the wave-1 channel handoff.
  describe('launch — recipient freeze hygiene', () => {
    const draft = {
      id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi', bodyHtml: null, audienceFilter: [],
    };

    it('clears PENDING/HOLD rows before re-freezing a DRAFT audience', async () => {
      prisma.campaign.findFirst.mockResolvedValue(draft);

      await svc.launch(WS, 'c1');

      expect(prisma.campaignRecipient.deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: WS, campaignId: 'c1', status: { in: ['PENDING', 'HOLD'] } },
      });
      // Order matters: the stale rows must be gone before the new freeze, or
      // skipDuplicates keeps them.
      expect(prisma.campaignRecipient.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.campaignRecipient.createMany.mock.invocationCallOrder[0],
      );
    });

    // SENT/FAILED/SKIPPED/UNSUBSCRIBED rows are the audit trail AND the token
    // behind every open pixel and unsubscribe link already sitting in an inbox.
    it('never deletes terminal recipient rows', async () => {
      prisma.campaign.findFirst.mockResolvedValue(draft);
      await svc.launch(WS, 'c1');
      const { status } = prisma.campaignRecipient.deleteMany.mock.calls[0][0].where;
      expect(status).toEqual({ in: ['PENDING', 'HOLD'] });
    });

    it('does NOT clear recipients when an admin re-launches a still-SCHEDULED campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...draft, status: 'SCHEDULED', scheduledAt: new Date(Date.now() - 60_000) });
      await svc.launch(WS, 'c1');
      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
    });

    // Wave-1 handoff: the denormalised channel must be frozen onto EVERY row,
    // including the A/B held-back remainder, or rows written after the deploy
    // carry a null channel and no bounce/complaint writer can find them.
    it('stamps the campaign channel on both the test and the held rows', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...draft, abEnabled: true, abMode: 'WINNER', abTestPercent: 20,
      });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }]);
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', weight: 1, body: 'a', bodyHtml: null },
        { key: 'B', weight: 1, body: 'b', bodyHtml: null },
      ]);

      await svc.launch(WS, 'c1');

      const rows = prisma.campaignRecipient.createMany.mock.calls[0][0].data;
      expect(rows.some((r: any) => r.status === 'HOLD')).toBe(true);
      expect(rows.every((r: any) => r.channel === 'EMAIL')).toBe(true);
    });

    // Index stability: `?i=` points into links[], so two computations over the
    // same content must produce the same order — which needs a deterministic
    // variant order.
    it('reads variants in a deterministic key order', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...draft, abEnabled: true });
      prisma.campaignVariant.findMany.mockResolvedValue([
        { key: 'A', weight: 1, body: 'a', bodyHtml: null },
        { key: 'B', weight: 1, body: 'b', bodyHtml: null },
      ]);

      await svc.launch(WS, 'c1');

      expect(prisma.campaignVariant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { key: 'asc' } }),
      );
    });
  });

  // img-src-click: an image load must never be counted as a click.
  describe('launch — tracked links', () => {
    it('tracks the <a href> and leaves the <img src> out of links[]', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu',
        body: 'Hi',
        bodyHtml: '<a href="https://shop.test/sale">Sale</a><img src="https://cdn.test/hero.jpg">',
        audienceFilter: [],
      });

      await svc.launch(WS, 'c1');

      const update = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(update.links).toEqual(['https://shop.test/sale']);
    });

    it('still tracks bare urls in the plain-text body (SMS and the text part)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'SMS',
        body: 'Kampanya: https://only.test', bodyHtml: null, audienceFilter: [],
      });

      await svc.launch(WS, 'c1');

      const update = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(update.links).toEqual(['https://only.test']);
    });

    /**
     * The click redirect resolves out of `links[]` on the PLATFORM's domain.
     * Launch is the one chokepoint every caller passes and the moment the array
     * is frozen, so it is where an unusable destination has to be refused —
     * afterwards the only check is "starts with http", at redirect time, which
     * is an open redirector with the platform's reputation behind it.
     */
    it('refuses to launch a campaign whose link hides credentials in the authority', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu',
        body: 'Hi',
        // Reads as acme.com to a person, resolves to evil.test.
        bodyHtml: '<a href="https://acme.com@evil.test/login">Hesabınız</a>',
        audienceFilter: [],
      });

      await expect(svc.launch(WS, 'c1')).rejects.toThrow(/CREDENTIALS_IN_URL/);
      // Nothing was frozen: the refusal lands before the campaign moves.
      expect(prisma.campaign.update).not.toHaveBeenCalled();
    });

    it('does not refuse an ordinary link with a port, a query and a fragment', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu',
        body: 'Hi',
        bodyHtml: '<a href="https://acme.com:8443/spring?utm_source=mail&amp;a=b#top">Bak</a>',
        audienceFilter: [],
      });

      await svc.launch(WS, 'c1');

      const update = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(update.links).toEqual(['https://acme.com:8443/spring?utm_source=mail&a=b#top']);
    });
  });

  // template-not-resolved: a template id must actually RENDER, server-side.
  describe('email templates', () => {
    beforeEach(() => {
      prisma.campaign.create = jest.fn().mockResolvedValue({ id: 'c1' });
    });

    it('create renders the template into bodyHtml when the caller sent none (the MCP path)', async () => {
      prisma.emailTemplate.findMany.mockResolvedValue([{ id: 't1', compiledHtml: '<p>Merhaba</p>' }]);

      await svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi', emailTemplateId: 't1' });

      expect(prisma.emailTemplate.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['t1'] }, workspaceId: WS },
        select: { id: true, compiledHtml: true },
      });
      expect(prisma.campaign.create.mock.calls[0][0].data.bodyHtml).toBe('<p>Merhaba</p>');
    });

    it('create refuses a template id that does not belong to this workspace', async () => {
      prisma.emailTemplate.findMany.mockResolvedValue([]);
      await expect(
        svc.create(WS, { name: 'N', channel: 'EMAIL', body: 'Hi', emailTemplateId: 'foreign' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.campaign.create).not.toHaveBeenCalled();
    });

    it('update renders a newly chosen template into bodyHtml', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL' });
      prisma.emailTemplate.findMany.mockResolvedValue([{ id: 't2', compiledHtml: '<p>v2</p>' }]);

      await svc.update(WS, 'c1', { emailTemplateId: 't2' });

      expect(prisma.campaign.update.mock.calls[0][0].data.bodyHtml).toBe('<p>v2</p>');
    });

    // The campaign form resends the stored id on every save. Validating an
    // UNCHANGED id would brick a campaign whose template was later deleted —
    // the operator could not even rename it.
    it('update does not re-validate an unchanged template id', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', emailTemplateId: 'gone',
      });

      await svc.update(WS, 'c1', { name: 'Renamed', emailTemplateId: 'gone' });

      expect(prisma.emailTemplate.findMany).not.toHaveBeenCalled();
      expect(prisma.campaign.update).toHaveBeenCalled();
    });

    it('create also lets the template win over a bodyHtml passed alongside it', async () => {
      prisma.emailTemplate.findMany.mockResolvedValue([{ id: 't1', compiledHtml: '<p>tpl</p>' }]);

      await svc.create(WS, {
        name: 'N', channel: 'EMAIL', body: 'Hi', bodyHtml: '<p>stale</p>', emailTemplateId: 't1',
      });

      expect(prisma.campaign.create.mock.calls[0][0].data.bodyHtml).toBe('<p>tpl</p>');
    });

    it('launch re-renders the template so an edit made after the draft was built does ship', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi',
        bodyHtml: '<a href="https://old.test">old</a>', emailTemplateId: 't1', audienceFilter: [],
      });
      prisma.emailTemplate.findMany.mockResolvedValue([
        { id: 't1', compiledHtml: '<a href="https://new.test">new</a>' },
      ]);

      await svc.launch(WS, 'c1');

      const update = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(update.bodyHtml).toBe('<a href="https://new.test">new</a>');
      // Tracked links come from the FRESH html, not the stale snapshot.
      expect(update.links).toEqual(['https://new.test']);
    });

    // A deleted template must not strand a draft that can no longer launch.
    it('launch falls back to the stored bodyHtml when the template is gone (no throw)', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', subject: 'Konu', body: 'Hi',
        bodyHtml: '<a href="https://old.test">old</a>', emailTemplateId: 'deleted', audienceFilter: [],
      });
      prisma.emailTemplate.findMany.mockResolvedValue([]);

      await svc.launch(WS, 'c1');

      const update = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(update.bodyHtml).toBeUndefined(); // untouched
      expect(update.links).toEqual(['https://old.test']);
    });

    // A/B sibling: a variant carrying only a template id used to inherit the
    // CONTROL's html — the wrong template's content, not merely plain text.
    it('setVariants renders a variant-level template id', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'c1', status: 'DRAFT' });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      prisma.campaign.updateMany = jest.fn();
      prisma.campaignVariant.deleteMany = jest.fn();
      prisma.campaignVariant.createMany = jest.fn();
      prisma.emailTemplate.findMany.mockResolvedValue([{ id: 'tv', compiledHtml: '<p>B</p>' }]);

      await svc.setVariants(WS, 'c1', { variants: [{ key: 'B', body: 'b', emailTemplateId: 'tv' }] });

      const rows = prisma.$transaction.mock.calls[0][0];
      expect(rows).toHaveLength(3);
      expect(prisma.campaignVariant.createMany.mock.calls[0][0].data[0].bodyHtml).toBe('<p>B</p>');
    });
  });

  // scheduled-links-stale: a SCHEDULED campaign has frozen links[] but has sent
  // nothing yet, so a body edit must refresh them (no index can have shipped).
  describe('update — link refresh on a SCHEDULED campaign', () => {
    it('re-extracts links when the body is edited', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL',
        body: 'Old https://old.test', bodyHtml: null, audienceFilter: [],
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });

      await svc.update(WS, 'c1', { body: 'New https://new.test' });

      expect(prisma.campaign.update.mock.calls[0][0].data.links).toEqual(['https://new.test']);
    });

    it('re-extracts links when the HTML body is edited, ignoring images', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL',
        body: 'Hi', bodyHtml: '<a href="https://old.test">o</a>', audienceFilter: [],
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });

      await svc.update(WS, 'c1', {
        bodyHtml: '<a href="https://new.test">n</a><img src="https://cdn.test/i.png">',
      });

      expect(prisma.campaign.update.mock.calls[0][0].data.links).toEqual(['https://new.test']);
    });

    it('leaves links alone when the edit does not touch the content', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL', body: 'Hi', bodyHtml: null,
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });

      await svc.update(WS, 'c1', { name: 'Renamed' });

      expect(prisma.campaign.update.mock.calls[0][0].data.links).toBeUndefined();
    });

    // A DRAFT has no frozen links yet — launch() computes them.
    it('does not compute links for a DRAFT body edit', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'c1', workspaceId: WS, status: 'DRAFT', channel: 'EMAIL', body: 'Hi', bodyHtml: null,
      });

      await svc.update(WS, 'c1', { body: 'New https://new.test' });

      expect(prisma.campaign.update.mock.calls[0][0].data.links).toBeUndefined();
    });
  });

  /**
   * `mcp-filter-rewrite`: an agent-created campaign writes its filter one way
   * and the composer re-reads and re-serialises it another, so saving a typo
   * fix in the subject looked like an audience change and silently cancelled
   * the send.
   */
  describe('update — an MCP-written filter survives an edit', () => {
    const scheduled = (filter: unknown) => ({
      id: 'c1', workspaceId: WS, status: 'SCHEDULED', channel: 'EMAIL', subject: 'Konu',
      audienceFilter: filter, scheduledAt: new Date(Date.now() + 86_400_000),
    });

    it('does not revert when only the stringification differs', async () => {
      prisma.campaign.findFirst.mockResolvedValue(
        scheduled([{ op: 'eq', field: 'id', value: 'lead-9' }]),
      );
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });

      // What the composer sends back: `lead.`-prefixed, values stringified,
      // keys in its own order.
      await svc.update(WS, 'c1', {
        subject: 'Yeni konu',
        audienceFilter: [{ field: 'lead.id', op: 'eq', value: 'lead-9' }],
      });

      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
      expect(scheduledJobs.cancel).not.toHaveBeenCalled();
    });

    it('still reverts when the audience really changes', async () => {
      prisma.campaign.findFirst.mockResolvedValue(
        scheduled([{ field: 'city', op: 'eq', value: 'Izmir' }]),
      );
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });

      const out: any = await svc.update(WS, 'c1', {
        audienceFilter: [{ field: 'city', op: 'eq', value: 'Ankara' }],
      });

      expect(out.status).toBe('DRAFT');
      expect(prisma.campaignRecipient.deleteMany).toHaveBeenCalled();
    });

    it('treats a number and its string form as the same rule', async () => {
      prisma.campaign.findFirst.mockResolvedValue(scheduled([{ field: 'priority', op: 'eq', value: 3 }]));
      prisma.campaign.update.mockResolvedValue({ id: 'c1', status: 'SCHEDULED' });

      await svc.update(WS, 'c1', { audienceFilter: [{ field: 'priority', op: 'eq', value: '3' }] });

      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('recipients', () => {
    beforeEach(() => {
      prisma.campaignRecipient.findMany = jest.fn().mockResolvedValue([]);
      prisma.campaignRecipient.count = jest.fn().mockResolvedValue(0);
      prisma.$transaction = jest.fn((ops: any[]) => Promise.all(ops));
    });

    it('attaches the person so the console shows a name, not an id', async () => {
      prisma.campaignRecipient.findMany.mockResolvedValue([
        { id: 'r1', leadId: 'l1', status: 'SENT' },
        { id: 'r2', leadId: 'l2', status: 'FAILED' },
      ]);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', contactPerson: 'Ayşe Yılmaz', businessName: 'Acme', email: 'a@x.io', phone: null },
      ]);

      const out = await svc.recipients(WS, 'c1');

      expect(prisma.campaignRecipient.findMany.mock.calls[0][0].where).toEqual({
        workspaceId: WS, campaignId: 'c1',
      });
      // The lead read is workspace-scoped in its own right, never trusted to
      // the recipient row alone.
      expect(prisma.lead.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['l1', 'l2'] }, workspaceId: WS },
        select: { id: true, contactPerson: true, businessName: true, email: true, phone: true },
      });
      expect(out.rows[0].lead).toEqual({ id: 'l1', contactPerson: 'Ayşe Yılmaz', businessName: 'Acme', email: 'a@x.io', phone: null });
      // A deleted lead leaves its recipient row readable, with no person on it.
      expect(out.rows[1].lead).toBeNull();
    });

    it('returns rows AND the total, so the console can say "x of n"', async () => {
      prisma.campaignRecipient.findMany.mockResolvedValue([{ id: 'r1', leadId: 'l1' }]);
      prisma.campaignRecipient.count.mockResolvedValue(412);
      prisma.lead.findMany.mockResolvedValue([]);
      const out = await svc.recipients(WS, 'c1');
      expect(out).toEqual({ rows: [{ id: 'r1', leadId: 'l1', lead: null }], total: 412 });
    });

    it('pages with a stable order, defaults to 50 and clamps take to 200', async () => {
      await svc.recipients(WS, 'c1', { take: 5000, skip: 20 });
      const args = prisma.campaignRecipient.findMany.mock.calls[0][0];
      expect(args.take).toBe(200);
      expect(args.skip).toBe(20);
      // A second key: rows are written WHILE a send is in flight, so createdAt
      // alone lets a row cross a page boundary and be shown twice or not at all.
      expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);

      prisma.campaignRecipient.findMany.mockClear();
      await svc.recipients(WS, 'c1');
      expect(prisma.campaignRecipient.findMany.mock.calls[0][0].take).toBe(50);
    });

    it('filters by a known status and ignores an unknown one', async () => {
      await svc.recipients(WS, 'c1', { status: 'FAILED' });
      expect(prisma.campaignRecipient.findMany.mock.calls[0][0].where).toEqual({
        workspaceId: WS, campaignId: 'c1', status: 'FAILED',
      });

      prisma.campaignRecipient.findMany.mockClear();
      await svc.recipients(WS, 'c1', { status: "'; DROP TABLE" });
      expect(prisma.campaignRecipient.findMany.mock.calls[0][0].where).toEqual({
        workspaceId: WS, campaignId: 'c1',
      });
    });

    it('counts with the same where it lists with', async () => {
      await svc.recipients(WS, 'c1', { status: 'SENT' });
      expect(prisma.campaignRecipient.count.mock.calls[0][0].where).toEqual(
        prisma.campaignRecipient.findMany.mock.calls[0][0].where,
      );
    });
  });
});
