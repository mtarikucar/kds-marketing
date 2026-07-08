import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';

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
