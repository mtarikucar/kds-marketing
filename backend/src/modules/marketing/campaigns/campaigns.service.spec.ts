import { BadRequestException } from '@nestjs/common';
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
    svc = new CampaignsService(prisma as any, scheduledJobs as any);
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
  });
});
