import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

/**
 * NetGSM SMS v2 Task 12 — lead phone verification (verifyPhoneStart/Confirm).
 *
 * Review fix round 1 (Finding 2 — lead phone-verify forgery): SmsOtpService.verify
 * used to scope only by (workspaceId, purpose, targetType, targetId), never the
 * phone itself — so a code texted to number A could confirm a claim about number
 * B if the lead's phone changed between start() and confirm(). The fix binds the
 * proof to the phone by requiring verifyPhoneConfirm to pass the lead's CURRENT
 * phone (read fresh, right here) into SmsOtpService.verify, which now rejects a
 * mismatch. The hard enforcement of that equality lives in
 * sms-otp.service.spec.ts (including the literal "start on A, swap to B, confirm
 * against B → FAILS" sequence); these tests instead prove the wiring at THIS
 * layer is correct — verifyPhoneConfirm always forwards a freshly-read phone,
 * never a stale one, and only stamps phoneVerifiedAt when SmsOtpService agrees.
 */
describe('MarketingLeadsService — verifyPhoneStart / verifyPhoneConfirm', () => {
  let prisma: MockPrismaClient;
  let smsOtp: { issue: jest.Mock; verify: jest.Mock };
  let svc: MarketingLeadsService;

  const WS = 'ws-1';
  const NUMBER_A = '05551110000';
  const NUMBER_B = '05559998888';

  function makeSvc() {
    prisma = mockPrismaClient();
    smsOtp = { issue: jest.fn(), verify: jest.fn() };
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, // emailService — unused
      {} as any, // autoAssigner — unused
      {} as any, // provisioning — unused
      {} as any, // outbox — unused
      {} as any, // customFields — unused
      {} as any, // hygiene — unused
      smsOtp as any,
    );
    return { prisma, smsOtp, svc };
  }

  describe('verifyPhoneStart', () => {
    it('throws NotFoundException when the lead is not in this workspace', async () => {
      const { prisma, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(svc.verifyPhoneStart(WS, 'lead-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when the lead has no phone on file', async () => {
      const { prisma, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', workspaceId: WS, phone: null } as any);
      await expect(svc.verifyPhoneStart(WS, 'lead-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('issues via SmsOtpService scoped to (LEAD_PHONE_VERIFY, LEAD, id) and the lead\'s current phone', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', workspaceId: WS, phone: NUMBER_A } as any);
      smsOtp.issue.mockResolvedValue({ ok: true });

      const out = await svc.verifyPhoneStart(WS, 'lead-1');

      expect(out).toEqual({ sent: true });
      expect(smsOtp.issue).toHaveBeenCalledWith(
        WS,
        { purpose: 'LEAD_PHONE_VERIFY', targetType: 'LEAD', targetId: 'lead-1' },
        NUMBER_A,
      );
    });

    it('surfaces the SmsOtpService failure message (e.g. NetGSM outage / no channel)', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', workspaceId: WS, phone: NUMBER_A } as any);
      smsOtp.issue.mockResolvedValue({ ok: false, message: 'No active NetGSM SMS channel is configured for this workspace.' });
      await expect(svc.verifyPhoneStart(WS, 'lead-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('verifyPhoneConfirm', () => {
    it('throws NotFoundException when the lead is not in this workspace', async () => {
      const { prisma, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(svc.verifyPhoneConfirm(WS, 'lead-1', '123456')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stamps phoneVerifiedAt when SmsOtpService confirms the code against the lead\'s current (unchanged) phone', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', workspaceId: WS, phone: NUMBER_A } as any);
      smsOtp.verify.mockResolvedValue({ ok: true });
      prisma.lead.update.mockResolvedValue({ id: 'lead-1', phoneVerifiedAt: new Date() } as any);

      const out: any = await svc.verifyPhoneConfirm(WS, 'lead-1', '123456');

      expect(out.phoneVerifiedAt).toBeInstanceOf(Date);
      expect(smsOtp.verify).toHaveBeenCalledWith(
        WS,
        { purpose: 'LEAD_PHONE_VERIFY', targetType: 'LEAD', targetId: 'lead-1' },
        '123456',
        NUMBER_A,
      );
      expect(prisma.lead.update).toHaveBeenCalledWith({
        where: { id: 'lead-1' },
        data: { phoneVerifiedAt: expect.any(Date) },
      });
    });

    it('throws BadRequestException and never stamps phoneVerifiedAt when SmsOtpService rejects the code', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', workspaceId: WS, phone: NUMBER_A } as any);
      smsOtp.verify.mockResolvedValue({ ok: false, message: 'Invalid code.' });

      await expect(svc.verifyPhoneConfirm(WS, 'lead-1', '000000')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lead.update).not.toHaveBeenCalled();
    });

    // The forgery sequence from the review: verifyPhoneStart() texts a code
    // to A; before confirm() runs, the lead's phone is edited to B (a
    // different actor, or the same one trying to launder a code meant for A
    // onto B). verifyPhoneConfirm() must read the lead FRESH at confirm time
    // and forward its CURRENT phone (B) — never a phone cached from start()
    // — so SmsOtpService.verify (which now requires phone equality with what
    // the code was issued for) has what it needs to reject the mismatch.
    it('reproduces the phone-swap forgery: passes the CURRENT (post-swap) phone, never a stale one, so a mismatched code is rejected and nothing is stamped', async () => {
      const { prisma, smsOtp, svc } = makeSvc();
      // By confirm() time the lead's phone in the DB is already B.
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', workspaceId: WS, phone: NUMBER_B } as any);
      // SmsOtpService is the one that actually enforces the phone match; it
      // rejects because the pending code was issued for A, not B (see
      // sms-otp.service.spec.ts's dedicated phone-binding tests for the
      // enforcement itself).
      smsOtp.verify.mockResolvedValue({ ok: false, message: 'No pending code — request a new one.' });

      await expect(svc.verifyPhoneConfirm(WS, 'lead-1', '123456')).rejects.toBeInstanceOf(BadRequestException);

      expect(smsOtp.verify).toHaveBeenCalledWith(
        WS,
        { purpose: 'LEAD_PHONE_VERIFY', targetType: 'LEAD', targetId: 'lead-1' },
        '123456',
        NUMBER_B, // fresh read — the swapped-to number, not A
      );
      expect(prisma.lead.update).not.toHaveBeenCalled();
    });
  });
});
