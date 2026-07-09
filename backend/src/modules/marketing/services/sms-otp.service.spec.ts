import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { SmsOtpService } from './sms-otp.service';
import { hmacHex } from '../../../common/crypto/secret-box.helper';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

// Review fix round 1 (Finding 4) — codes are now HMAC-SHA256 keyed with
// MARKETING_SECRET_KEY (not a plain unkeyed sha256), so every test needs the
// master key configured; mirrors two-factor.service.spec.ts's sealed-secret
// describe block.
const MARKETING_SECRET_KEY = Buffer.alloc(32, 4).toString('base64');

function hashCode(code: string): string {
  return hmacHex(`sms-otp-code:${code}`);
}

function makeSvc() {
  const prisma = mockPrismaClient();
  const channelRegistry = { resolveConfig: jest.fn() } as any;
  const smsV2 = { otp: jest.fn() } as any;
  // Interactive-transaction shim (same convention as
  // marketing-auth.workspace.spec.ts): the callback just runs against the
  // same mocked prisma object, so every existing prisma.smsOtpCode.* mock
  // keeps working unchanged whether or not the real code wraps a call in
  // $transaction.
  (prisma.$transaction as unknown as jest.Mock).mockImplementation((fn: any) => fn(prisma));
  (prisma.smsOtpCode.count as jest.Mock).mockResolvedValue(0);
  const svc = new SmsOtpService(prisma as any, channelRegistry, smsV2);
  return { prisma, channelRegistry, smsV2, svc };
}

const TARGET = { purpose: 'LEAD_PHONE_VERIFY' as const, targetType: 'LEAD' as const, targetId: 'lead-1' };
const PHONE = '05551234567';
const ACTIVE_SMS_CHANNEL = { id: 'chan-1', workspaceId: 'ws-1', type: 'SMS', status: 'ACTIVE' };
const RESOLVED_CONFIG = {
  secrets: { usercode: '850u', password: 'pw', msgheader: 'JEETA' },
  public: {},
};

function mockPrismaForIssue(prisma: MockPrismaClient, opts: { lastRow?: any; recentCount?: number } = {}) {
  (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
  (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(opts.lastRow ?? null);
  (prisma.smsOtpCode.count as jest.Mock).mockResolvedValue(opts.recentCount ?? 0);
  (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  (prisma.smsOtpCode.create as jest.Mock).mockResolvedValue({
    id: 'code-1',
    workspaceId: 'ws-1',
    ...TARGET,
    phone: PHONE,
    codeHash: 'irrelevant',
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 3 * 60_000),
    createdAt: new Date(),
  });
  (prisma.smsOtpCode.delete as jest.Mock).mockResolvedValue({});
}

describe('SmsOtpService', () => {
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = MARKETING_SECRET_KEY;
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  describe('issue', () => {
    it('refuses when no phone is on file', async () => {
      const { svc } = makeSvc();
      const out = await svc.issue('ws-1', TARGET, '');
      expect(out.ok).toBe(false);
    });

    it('refuses when the workspace has no ACTIVE NetGSM SMS channel', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(null);
      const out = await svc.issue('ws-1', TARGET, PHONE);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/SMS channel/);
    });

    it('refuses when the channel secrets are incomplete (missing msgheader)', async () => {
      const { prisma, channelRegistry, svc } = makeSvc();
      (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
      channelRegistry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u', password: 'p' }, public: {} });
      const out = await svc.issue('ws-1', TARGET, PHONE);
      expect(out.ok).toBe(false);
    });

    it('refuses inside the resend cooldown without calling NetGSM', async () => {
      const { prisma, channelRegistry, smsV2, svc } = makeSvc();
      channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
      mockPrismaForIssue(prisma, { lastRow: { createdAt: new Date(), consumedAt: null } });
      const out = await svc.issue('ws-1', TARGET, PHONE);
      expect(out.ok).toBe(false);
      expect(smsV2.otp).not.toHaveBeenCalled();
    });

    it('issues a hashed 6-digit code via the ASCII-only template, consuming any prior pending code first', async () => {
      const { prisma, channelRegistry, smsV2, svc } = makeSvc();
      channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
      mockPrismaForIssue(prisma);
      smsV2.otp.mockResolvedValue({ ok: true, code: '00', jobid: 'job-1', message: null, retriable: false, transport: false });

      const out = await svc.issue('ws-1', TARGET, PHONE);

      expect(out.ok).toBe(true);
      // Prior pending codes for the SAME target are consumed before the new one is minted.
      expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...TARGET, consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
      const createArgs = (prisma.smsOtpCode.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.phone).toBe(PHONE);
      // The raw code is never persisted — only its HMAC-SHA256 hash.
      expect(createArgs.data.codeHash).toHaveLength(64);
      expect(createArgs.data.codeHash).not.toMatch(/^\d{6}$/);

      const otpArgs = smsV2.otp.mock.calls[0][1];
      expect(otpArgs.msgheader).toBe('JEETA');
      expect(otpArgs.no).toBe(PHONE);
      // ASCII-only (no Turkish characters) — SmsV2Client.otp enforces this.
      expect(otpArgs.msg).toMatch(/^Jeeta dogrulama kodunuz: \d{6}$/);
      expect(otpArgs.msg).not.toMatch(/[çÇğĞıİöÖşŞüÜ]/);
      // The hash actually matches the code embedded in the sent message.
      const sentCode = otpArgs.msg.match(/(\d{6})$/)![1];
      expect(createArgs.data.codeHash).toBe(hashCode(sentCode));
    });

    it('rolls back the persisted row when the NetGSM send itself fails (e.g. code 60 — no OTP package)', async () => {
      const { prisma, channelRegistry, smsV2, svc } = makeSvc();
      channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
      mockPrismaForIssue(prisma);
      smsV2.otp.mockResolvedValue({
        ok: false, code: '60', jobid: null,
        message: 'NetGSM hesabında bu işlem için yetki veya tanımlı paket yok (kod 60).',
        retriable: false, transport: false,
      });

      const out = await svc.issue('ws-1', TARGET, PHONE);

      expect(out.ok).toBe(false);
      expect(out.code).toBe('60');
      expect(prisma.smsOtpCode.delete).toHaveBeenCalledWith({ where: { id: 'code-1' } });
    });

    // Review fix round 1 (Finding 5) — per-target rolling-hour issuance cap.
    describe('rolling-hour issuance cap (Finding 5)', () => {
      it('refuses once the target already has 10 codes issued within the last hour, without calling NetGSM', async () => {
        const { prisma, channelRegistry, smsV2, svc } = makeSvc();
        channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
        mockPrismaForIssue(prisma, { recentCount: 10 });

        const out = await svc.issue('ws-1', TARGET, PHONE);

        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/too many/i);
        expect(smsV2.otp).not.toHaveBeenCalled();
        expect(prisma.smsOtpCode.create).not.toHaveBeenCalled();
      });

      it('still allows issuance under the cap (9 in the last hour)', async () => {
        const { prisma, channelRegistry, smsV2, svc } = makeSvc();
        channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
        mockPrismaForIssue(prisma, { recentCount: 9 });
        smsV2.otp.mockResolvedValue({ ok: true, code: '00', jobid: 'j', message: null, retriable: false, transport: false });

        const out = await svc.issue('ws-1', TARGET, PHONE);
        expect(out.ok).toBe(true);
      });
    });

    // Review fix round 1 (Finding 3, issue-side) — the cooldown/cap
    // check-then-act now runs inside a SERIALIZABLE transaction so Postgres
    // itself catches a concurrent race; a losing transaction surfaces as a
    // P2034 conflict, which issue() must translate into a clean refusal
    // rather than a raw 500.
    describe('concurrent-issue race (Finding 3, lower priority)', () => {
      it('treats a P2034 transaction conflict as "wait a moment" rather than throwing', async () => {
        const { prisma, channelRegistry, smsV2, svc } = makeSvc();
        channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
        (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
        const conflict = new Prisma.PrismaClientKnownRequestError('Transaction conflict', {
          code: 'P2034',
          clientVersion: 'test',
        });
        (prisma.$transaction as unknown as jest.Mock).mockRejectedValueOnce(conflict);

        const out = await svc.issue('ws-1', TARGET, PHONE);

        expect(out.ok).toBe(false);
        expect(smsV2.otp).not.toHaveBeenCalled();
      });

      it('runs the cooldown/cap check + consume + create inside $transaction with SERIALIZABLE isolation', async () => {
        const { prisma, channelRegistry, smsV2, svc } = makeSvc();
        channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
        mockPrismaForIssue(prisma);
        smsV2.otp.mockResolvedValue({ ok: true, code: '00', jobid: 'j', message: null, retriable: false, transport: false });

        await svc.issue('ws-1', TARGET, PHONE);

        expect(prisma.$transaction).toHaveBeenCalledWith(
          expect.any(Function),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      });
    });
  });

  describe('verify', () => {
    function row(overrides: Partial<{
      attempts: number; maxAttempts: number; expiresAt: Date; consumedAt: Date | null; codeHash: string; phone: string;
    }> = {}) {
      return {
        id: 'code-1',
        workspaceId: 'ws-1',
        ...TARGET,
        phone: PHONE,
        codeHash: hashCode('123456'),
        attempts: 0,
        maxAttempts: 5,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        ...overrides,
      };
    }

    it('refuses when there is no pending code', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(null);
      const out = await svc.verify('ws-1', TARGET, '123456', PHONE);
      expect(out.ok).toBe(false);
    });

    it('refuses an expired code and invalidates it', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }));
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '123456', PHONE);
      expect(out.ok).toBe(false);
      expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('refuses once attempts already reached maxAttempts', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 5 }));
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '123456', PHONE);
      expect(out.ok).toBe(false);
      expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('an incorrect code increments attempts without consuming the row (attempts remaining)', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 1 }));
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '000000', PHONE);
      expect(out.ok).toBe(false);
      expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', attempts: 1, consumedAt: null },
        data: { attempts: 2 },
      });
    });

    it('the wrong attempt that TRIPS the cap invalidates the row in the same write', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 4, maxAttempts: 5 }));
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '000000', PHONE);
      expect(out.ok).toBe(false);
      expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', attempts: 4, consumedAt: null },
        data: { attempts: 5, consumedAt: expect.any(Date) },
      });
    });

    it('a correct code verifies once and consumes the row', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row());
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '123456', PHONE);
      expect(out.ok).toBe(true);
      expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('trims whitespace on the submitted code before hashing', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row());
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '  123456  ', PHONE);
      expect(out.ok).toBe(true);
    });

    // Review fix round 1 (Finding 2) — the proof is bound to the phone the
    // code was actually issued to.
    describe('phone binding (Finding 2 — forgery across a phone swap)', () => {
      it('rejects a correct code when the caller-supplied phone does not match the phone the code was issued to', async () => {
        const { prisma, svc } = makeSvc();
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ phone: '05551110000' }));
        const out = await svc.verify('ws-1', TARGET, '123456', '05559998888');
        expect(out.ok).toBe(false);
        // No attempt/consumed mutation on a phone mismatch — it's treated
        // exactly like "no pending code", not a wrong guess.
        expect(prisma.smsOtpCode.updateMany).not.toHaveBeenCalled();
      });

      it('reproduces the full forgery sequence from the review: start on number A, swap the target to B, confirm against B → FAILS', async () => {
        const { prisma, svc } = makeSvc();
        const NUMBER_A = '05551110000';
        const NUMBER_B = '05559998888';
        // The pending row was issued to A (as start() would have stored it).
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ phone: NUMBER_A }));
        // confirm() now passes the target's CURRENT phone (B, after the swap).
        const out = await svc.verify('ws-1', TARGET, '123456', NUMBER_B);
        expect(out.ok).toBe(false);
      });

      it('accepts a formatting-only variant of the same phone (normalized compare)', async () => {
        const { prisma, svc } = makeSvc();
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ phone: '0555 123 45 67' }));
        (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        const out = await svc.verify('ws-1', TARGET, '123456', '0555-123-45-67');
        expect(out.ok).toBe(true);
      });

      it('rejects when no phone is supplied at all (null)', async () => {
        const { prisma, svc } = makeSvc();
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row());
        const out = await svc.verify('ws-1', TARGET, '123456', null);
        expect(out.ok).toBe(false);
      });
    });

    // Review fix round 1 (Finding 3) — the attempt increment is now an
    // optimistic-lock updateMany keyed off the read snapshot's `attempts`.
    describe('atomic attempt increment (Finding 3)', () => {
      it('keys the conditional updateMany off the exact attempts value this call read (closes the concurrent-guess race)', async () => {
        const { prisma, svc } = makeSvc();
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 2 }));
        // Simulate having LOST the race: another concurrent guess already
        // bumped attempts (or consumed the row) between our read and this
        // write, so the conditional predicate matches 0 rows.
        (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const out = await svc.verify('ws-1', TARGET, '000000', PHONE);

        // Losing the race still fails THIS call's guess (never a bonus pass) —
        // and critically, the predicate below is what prevents a second
        // concurrent winner from also incrementing off the same stale value.
        expect(out.ok).toBe(false);
        expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
          where: { id: 'code-1', attempts: 2, consumedAt: null },
          data: { attempts: 3 },
        });
      });

      it('a success whose consumedAt updateMany matches 0 rows (already invalidated by a racing call) is NOT honored', async () => {
        const { prisma, svc } = makeSvc();
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row());
        (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const out = await svc.verify('ws-1', TARGET, '123456', PHONE);

        expect(out.ok).toBe(false);
        expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
          where: { id: 'code-1', consumedAt: null },
          data: { consumedAt: expect.any(Date) },
        });
      });
    });
  });

  // Review fix round 1 (Finding 4) — HMAC-SHA256 pepper instead of a plain
  // unkeyed hash.
  describe('code hashing (Finding 4 — HMAC pepper, not plain SHA-256)', () => {
    it('is deterministic for the same code', () => {
      expect(hashCode('123456')).toBe(hashCode('123456'));
    });

    it('does NOT match a plain unkeyed SHA-256 of the raw code (the whole point of peppering)', () => {
      const plainSha256 = createHash('sha256').update('123456').digest('hex');
      expect(hashCode('123456')).not.toBe(plainSha256);
    });

    it('a correct-code verify still succeeds end-to-end against the HMAC hash actually stored', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue({
        id: 'code-1', workspaceId: 'ws-1', ...TARGET, phone: PHONE,
        codeHash: hashCode('654321'), attempts: 0, maxAttempts: 5, consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
      });
      (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const out = await svc.verify('ws-1', TARGET, '654321', PHONE);
      expect(out.ok).toBe(true);
    });
  });

  // hashCode() (Finding 4) is a hard dependency on the master key, so issue()
  // and verify() both explicitly guard with isSecretBoxConfigured() to fail
  // clean instead of letting hmacHex() throw an uncaught Error. Needs a truly
  // uncached secret-box module (its masterKey() caches the key at module
  // scope once resolved — the rest of this file's tests keep it warm for the
  // whole run), so this uses jest.resetModules() + a fresh require, exactly
  // like secret-box.helper.spec.ts does for its own equivalent case. This
  // does NOT affect the top-level `hashCode`/`makeSvc` used everywhere else
  // in this file — those keep referencing the module instance bound at file
  // load, independent of resetModules() calls made later.
  describe('fails closed when MARKETING_SECRET_KEY is unconfigured (guards hashCode\'s hard dependency)', () => {
    function freshSvc() {
      const { SmsOtpService: FreshSmsOtpService } = require('./sms-otp.service');
      const prisma = mockPrismaClient();
      const channelRegistry = { resolveConfig: jest.fn() } as any;
      const smsV2 = { otp: jest.fn() } as any;
      (prisma.$transaction as unknown as jest.Mock).mockImplementation((fn: any) => fn(prisma));
      return { prisma, svc: new FreshSmsOtpService(prisma as any, channelRegistry, smsV2) };
    }

    it('issue() refuses cleanly (no uncaught throw)', async () => {
      const saved = process.env.MARKETING_SECRET_KEY;
      delete process.env.MARKETING_SECRET_KEY;
      jest.resetModules();
      try {
        const { svc } = freshSvc();
        const out = await svc.issue('ws-1', TARGET, PHONE);
        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/MARKETING_SECRET_KEY/);
      } finally {
        process.env.MARKETING_SECRET_KEY = saved;
        jest.resetModules();
      }
    });

    it('verify() refuses cleanly (no uncaught throw)', async () => {
      const saved = process.env.MARKETING_SECRET_KEY;
      delete process.env.MARKETING_SECRET_KEY;
      jest.resetModules();
      try {
        const { prisma, svc } = freshSvc();
        (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue({
          id: 'code-1', workspaceId: 'ws-1', ...TARGET, phone: PHONE,
          codeHash: 'irrelevant', attempts: 0, maxAttempts: 5, consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
        });
        const out = await svc.verify('ws-1', TARGET, '123456', PHONE);
        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/MARKETING_SECRET_KEY/);
      } finally {
        process.env.MARKETING_SECRET_KEY = saved;
        jest.resetModules();
      }
    });
  });
});
