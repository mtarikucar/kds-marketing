import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import {
  CoreProvisioningEmailInUseError,
  CoreProvisioningPlanInvalidError,
} from '../../../core-contracts/provisioning/tenant-provisioning.types';

/**
 * Step D: convert() no longer writes tenant/user/subscription — it delegates to
 * CoreProvisioningPort and only finalizes marketing state. These tests lock the
 * decoupling (no core-table writes), the saga claim, the commission basis from
 * plan facts, and the orphan-reconciliation sweep — all workspace-scoped:
 * convert() takes the caller's workspaceId; the reconcile cron resolves the
 * single core-integrated workspace itself (no user context).
 */
describe('MarketingLeadsService — convert + reconcile', () => {
  let prisma: MockPrismaClient;
  let email: { sendEmail: jest.Mock };
  let provisioning: {
    provisionTenantForLead: jest.Mock;
    listProvisionedLeads: jest.Mock;
  };
  let outbox: { append: jest.Mock };
  let svc: MarketingLeadsService;

  const WS = 'ws-1';

  const DTO = {
    tenantName: 'Test Bistro',
    adminEmail: 'owner@test.com',
    adminFirstName: 'Ada',
    adminLastName: 'Lovelace',
  } as any;

  const provisionResult = {
    tenantId: 'tenant-1',
    adminUserId: 'admin-1',
    subscriptionId: 'sub-1',
    subdomain: 'test-bistro',
    adminTempPassword: 'secret',
    created: true,
    planFacts: { monthlyPrice: 1299, commissionRate: 0.15, planCode: 'PRO' },
  };

  beforeEach(() => {
    // Genericization: the welcome email is only sent when the core product's
    // public URL is configured (no more hardcoded product domain fallback).
    process.env.APP_URL = 'https://core.example.com';
    process.env.APP_NAME = 'ExampleCore';
    prisma = mockPrismaClient();
    email = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    provisioning = {
      provisionTenantForLead: jest.fn().mockResolvedValue(provisionResult),
      listProvisionedLeads: jest.fn().mockResolvedValue([]),
    };
    outbox = { append: jest.fn().mockResolvedValue('outbox-id') };
    svc = new MarketingLeadsService(
      prisma as any,
      email as any,
      {} as any, // autoAssigner — unused by convert/reconcile
      provisioning as any,
      outbox as any,
      { validateAndNormalize: jest.fn().mockResolvedValue({}) } as any, // customFields
      { verify: jest.fn().mockResolvedValue('UNKNOWN') } as any, // hygiene
    );
    (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
    // The reconcile cron resolves the core-integrated workspace via the
    // helper (workspace.findFirst); convert() gets WS from the caller.
    prisma.workspace.findFirst.mockResolvedValue({ id: WS } as any);
    // Scoped pre-checks read via findFirst({ where: { id, workspaceId } }).
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      convertedTenantId: null,
      assignedToId: 'rep-1',
    } as any);
    prisma.lead.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.lead.findUniqueOrThrow.mockResolvedValue({ id: 'lead-1', status: 'WON' } as any);
    prisma.marketingTask.updateMany.mockResolvedValue({ count: 0 } as any);
    prisma.commission.create.mockResolvedValue({ id: 'comm-1' } as any);
    prisma.leadActivity.create.mockResolvedValue({} as any);
  });

  afterEach(() => {
    delete process.env.APP_URL;
    delete process.env.APP_NAME;
  });

  describe('convert', () => {
    it('provisions via the port and finalizes (claim + commission + event + email), touching NO core tables', async () => {
      const res = await svc.convert(WS, 'lead-1', DTO, 'user-1');

      // The pre-check resolves the lead scoped to the caller's workspace.
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-1', workspaceId: WS } }),
      );
      expect(provisioning.provisionTenantForLead).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 'lead-1',
          idempotencyKey: 'lead-convert:lead-1',
          tenantName: 'Test Bistro',
          admin: { email: 'owner@test.com', firstName: 'Ada', lastName: 'Lovelace' },
        }),
      );
      expect(prisma.lead.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'lead-1', workspaceId: WS, convertedTenantId: null },
          data: expect.objectContaining({ status: 'WON', convertedTenantId: 'tenant-1' }),
        }),
      );
      // commission basis = plan monthly price × rate = 1299 × 0.15 = 194.85
      const commData = (prisma.commission.create as any).mock.calls[0][0].data;
      expect(commData.amount.toString()).toBe('194.85');
      expect(commData).toMatchObject({
        workspaceId: WS,
        type: 'SIGNUP',
        tenantId: 'tenant-1',
        leadId: 'lead-1',
        marketingUserId: 'rep-1',
      });
      expect(outbox.append).toHaveBeenCalled();
      expect(outbox.append.mock.calls[0][0]).toMatchObject({
        type: 'marketing.lead.converted.v1',
        payload: expect.objectContaining({ leadId: 'lead-1', tenantId: 'tenant-1', commissionId: 'comm-1' }),
      });
      expect(email.sendEmail).toHaveBeenCalled();
      // Branding comes from env, never from a hardcoded product domain.
      expect(email.sendEmail.mock.calls[0][0]).toMatchObject({
        subject: 'ExampleCore hesabınız hazır',
        context: expect.objectContaining({
          appUrl: 'https://core.example.com',
          loginUrl: 'https://core.example.com/login',
        }),
      });
      expect(res).toMatchObject({ tenantId: 'tenant-1' });

      // Decoupling invariant: marketing wrote none of the core tables.
      expect((prisma as any).tenant.create).not.toHaveBeenCalled();
      expect((prisma as any).user.create).not.toHaveBeenCalled();
      expect((prisma as any).subscription.create).not.toHaveBeenCalled();
    });

    it('skips the welcome email (but still converts) when APP_URL is not configured', async () => {
      delete process.env.APP_URL;
      const res = await svc.convert(WS, 'lead-1', DTO, 'user-1');
      expect(res).toMatchObject({ tenantId: 'tenant-1' });
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('throws NotFound when the lead is missing (or lives in another workspace)', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(svc.convert(WS, 'x', DTO, 'u')).rejects.toBeInstanceOf(NotFoundException);
      expect(provisioning.provisionTenantForLead).not.toHaveBeenCalled();
    });

    it('throws Conflict when the lead is already converted', async () => {
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', convertedTenantId: 'tenant-x' } as any);
      await expect(svc.convert(WS, 'lead-1', DTO, 'u')).rejects.toBeInstanceOf(ConflictException);
      expect(provisioning.provisionTenantForLead).not.toHaveBeenCalled();
    });

    it('maps CoreProvisioningEmailInUseError → Conflict', async () => {
      provisioning.provisionTenantForLead.mockRejectedValue(
        new CoreProvisioningEmailInUseError('owner@test.com'),
      );
      await expect(svc.convert(WS, 'lead-1', DTO, 'u')).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps CoreProvisioningPlanInvalidError → BadRequest', async () => {
      provisioning.provisionTenantForLead.mockRejectedValue(
        new CoreProvisioningPlanInvalidError('plan-x'),
      );
      await expect(svc.convert(WS, 'lead-1', DTO, 'u')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('aborts with Conflict when the concurrent claim loses (count=0) — no commission', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 0 } as any);
      await expect(svc.convert(WS, 'lead-1', DTO, 'u')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.commission.create).not.toHaveBeenCalled();
    });

    it('skips the commission when the lead is unassigned (still emits the event)', async () => {
      prisma.lead.findFirst.mockResolvedValue({
        id: 'lead-1',
        convertedTenantId: null,
        assignedToId: null,
      } as any);
      await svc.convert(WS, 'lead-1', DTO, 'u');
      expect(prisma.commission.create).not.toHaveBeenCalled();
      expect(outbox.append).toHaveBeenCalled();
    });

    it('does not re-send the welcome email on an idempotent replay (created=false)', async () => {
      provisioning.provisionTenantForLead.mockResolvedValue({
        ...provisionResult,
        created: false,
        adminTempPassword: '',
      });
      await svc.convert(WS, 'lead-1', DTO, 'u');
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('files the commission in the UTC month, not local time: 2026-06-30T22:30Z → period 2026-06', async () => {
      // 22:30 UTC on Jun 30 is already Jul 1 in TZ ahead of UTC (e.g. +03:00).
      // Local getMonth()/getFullYear() would bucket this as 2026-07; the
      // commission period must stay on the UTC basis shared by attainment
      // bucketing (Date.UTC) and the settlement consumer (occurredAt.slice(0,7)).
      jest.useFakeTimers().setSystemTime(new Date('2026-06-30T22:30:00.000Z'));
      try {
        await svc.convert(WS, 'lead-1', DTO, 'user-1');
        const commData = (prisma.commission.create as any).mock.calls[0][0].data;
        expect(commData.period).toBe('2026-06');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('reconcileOrphanProvisionedConversions', () => {
    it('finalizes an orphan (provisioned but lead still unconverted) under the core-integrated workspace', async () => {
      provisioning.listProvisionedLeads.mockResolvedValue([
        { leadId: 'lead-1', tenantId: 'tenant-1', planFacts: { monthlyPrice: 1299, commissionRate: 0.15, planCode: 'PRO' } },
      ]);
      prisma.lead.findFirst.mockResolvedValue({
        id: 'lead-1',
        assignedToId: 'rep-1',
        convertedTenantId: null,
      } as any);

      const res = await svc.reconcileOrphanProvisionedConversions();

      expect(res.reconciled).toBe(1);
      // The orphan lookup itself is scoped to the resolved workspace.
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-1', workspaceId: WS } }),
      );
      expect(prisma.lead.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-1', workspaceId: WS, convertedTenantId: null } }),
      );
      expect(prisma.commission.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ workspaceId: WS, type: 'SIGNUP', tenantId: 'tenant-1', leadId: 'lead-1' }) }),
      );
      expect(outbox.append).toHaveBeenCalled();
    });

    it('skips a lead that is already converted', async () => {
      provisioning.listProvisionedLeads.mockResolvedValue([
        { leadId: 'lead-1', tenantId: 'tenant-1', planFacts: null },
      ]);
      prisma.lead.findFirst.mockResolvedValue({
        id: 'lead-1',
        assignedToId: 'rep-1',
        convertedTenantId: 'tenant-1',
      } as any);

      const res = await svc.reconcileOrphanProvisionedConversions();

      expect(res.reconciled).toBe(0);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('returns 0 when there are no recent provisioned leads', async () => {
      provisioning.listProvisionedLeads.mockResolvedValue([]);
      const res = await svc.reconcileOrphanProvisionedConversions();
      expect(res.reconciled).toBe(0);
    });

    it('skips the sweep entirely (warn) when no core-integrated workspace exists', async () => {
      prisma.workspace.findFirst.mockResolvedValue(null);
      const res = await svc.reconcileOrphanProvisionedConversions();
      expect(res.reconciled).toBe(0);
      expect(provisioning.listProvisionedLeads).not.toHaveBeenCalled();
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('terminal-state guards', () => {
    it('convert() refuses a LOST lead (no re-opening a terminal lead to WON)', async () => {
      prisma.lead.findFirst.mockResolvedValue({
        id: 'lead-1',
        convertedTenantId: null,
        status: 'LOST',
        assignedToId: 'rep-1',
      } as any);
      await expect(svc.convert(WS, 'lead-1', DTO, 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // Never provisioned a tenant for a lost lead.
      expect(provisioning.provisionTenantForLead).not.toHaveBeenCalled();
    });

    it('delete()/archive refuses a converted lead (would dangle its tenant + commission)', async () => {
      prisma.lead.findFirst.mockResolvedValue({
        id: 'lead-1',
        status: 'WON',
        convertedTenantId: 'tenant-1',
      } as any);
      await expect(svc.delete(WS, 'lead-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lead.update).not.toHaveBeenCalled();
    });
  });

  describe('workflow-trigger events', () => {
    it('updateStatus emits the lead.status_changed trigger on a real transition', async () => {
      prisma.lead.findFirst.mockResolvedValue({
        id: 'lead-1',
        status: 'CONTACTED',
        assignedToId: 'rep-1',
        convertedTenantId: null,
      } as any);
      prisma.lead.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.lead.findUniqueOrThrow.mockResolvedValue({
        id: 'lead-1',
        status: 'WAITING',
        businessName: 'X',
        assignedToId: 'rep-1',
      } as any);
      outbox.append.mockClear();

      await svc.updateStatus(WS, 'lead-1', 'WAITING', undefined, 'user-1', 'MANAGER');

      expect(outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'marketing.lead.status_changed.v1',
          payload: expect.objectContaining({
            workspaceId: WS,
            leadId: 'lead-1',
            fromStatus: 'CONTACTED',
            toStatus: 'WAITING',
          }),
        }),
      );
    });
  });
});
