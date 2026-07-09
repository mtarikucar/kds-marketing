import { createHash } from 'crypto';
import { SmsOtpService } from './sms-otp.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function makeSvc() {
  const prisma = mockPrismaClient();
  const channelRegistry = { resolveConfig: jest.fn() } as any;
  const smsV2 = { otp: jest.fn() } as any;
  const svc = new SmsOtpService(prisma as any, channelRegistry, smsV2);
  return { prisma, channelRegistry, smsV2, svc };
}

const TARGET = { purpose: 'LEAD_PHONE_VERIFY' as const, targetType: 'LEAD' as const, targetId: 'lead-1' };
const ACTIVE_SMS_CHANNEL = { id: 'chan-1', workspaceId: 'ws-1', type: 'SMS', status: 'ACTIVE' };
const RESOLVED_CONFIG = {
  secrets: { usercode: '850u', password: 'pw', msgheader: 'JEETA' },
  public: {},
};

function mockPrismaForIssue(prisma: MockPrismaClient, opts: { lastRow?: any } = {}) {
  (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
  (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(opts.lastRow ?? null);
  (prisma.smsOtpCode.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  (prisma.smsOtpCode.create as jest.Mock).mockResolvedValue({
    id: 'code-1',
    workspaceId: 'ws-1',
    ...TARGET,
    phone: '05551234567',
    codeHash: 'irrelevant',
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 3 * 60_000),
    createdAt: new Date(),
  });
  (prisma.smsOtpCode.delete as jest.Mock).mockResolvedValue({});
}

describe('SmsOtpService.issue', () => {
  it('refuses when no phone is on file', async () => {
    const { svc } = makeSvc();
    const out = await svc.issue('ws-1', TARGET, '');
    expect(out.ok).toBe(false);
  });

  it('refuses when the workspace has no ACTIVE NetGSM SMS channel', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.channel.findFirst as jest.Mock).mockResolvedValue(null);
    const out = await svc.issue('ws-1', TARGET, '05551234567');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/SMS channel/);
  });

  it('refuses when the channel secrets are incomplete (missing msgheader)', async () => {
    const { prisma, channelRegistry, svc } = makeSvc();
    (prisma.channel.findFirst as jest.Mock).mockResolvedValue(ACTIVE_SMS_CHANNEL);
    channelRegistry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u', password: 'p' }, public: {} });
    const out = await svc.issue('ws-1', TARGET, '05551234567');
    expect(out.ok).toBe(false);
  });

  it('refuses inside the resend cooldown without calling NetGSM', async () => {
    const { prisma, channelRegistry, smsV2, svc } = makeSvc();
    channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
    mockPrismaForIssue(prisma, { lastRow: { createdAt: new Date(), consumedAt: null } });
    const out = await svc.issue('ws-1', TARGET, '05551234567');
    expect(out.ok).toBe(false);
    expect(smsV2.otp).not.toHaveBeenCalled();
  });

  it('issues a hashed 6-digit code via the ASCII-only template, consuming any prior pending code first', async () => {
    const { prisma, channelRegistry, smsV2, svc } = makeSvc();
    channelRegistry.resolveConfig.mockReturnValue(RESOLVED_CONFIG);
    mockPrismaForIssue(prisma);
    smsV2.otp.mockResolvedValue({ ok: true, code: '00', jobid: 'job-1', message: null, retriable: false, transport: false });

    const out = await svc.issue('ws-1', TARGET, '05551234567');

    expect(out.ok).toBe(true);
    // Prior pending codes for the SAME target are consumed before the new one is minted.
    expect(prisma.smsOtpCode.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', ...TARGET, consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    const createArgs = (prisma.smsOtpCode.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.phone).toBe('05551234567');
    // The raw code is never persisted — only its SHA-256 hash.
    expect(createArgs.data.codeHash).toHaveLength(64);
    expect(createArgs.data.codeHash).not.toMatch(/^\d{6}$/);

    const otpArgs = smsV2.otp.mock.calls[0][1];
    expect(otpArgs.msgheader).toBe('JEETA');
    expect(otpArgs.no).toBe('05551234567');
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

    const out = await svc.issue('ws-1', TARGET, '05551234567');

    expect(out.ok).toBe(false);
    expect(out.code).toBe('60');
    expect(prisma.smsOtpCode.delete).toHaveBeenCalledWith({ where: { id: 'code-1' } });
  });
});

describe('SmsOtpService.verify', () => {
  function row(overrides: Partial<{
    attempts: number; maxAttempts: number; expiresAt: Date; consumedAt: Date | null; codeHash: string;
  }> = {}) {
    return {
      id: 'code-1',
      workspaceId: 'ws-1',
      ...TARGET,
      phone: '05551234567',
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
    const out = await svc.verify('ws-1', TARGET, '123456');
    expect(out.ok).toBe(false);
  });

  it('refuses an expired code and invalidates it', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }));
    (prisma.smsOtpCode.update as jest.Mock).mockResolvedValue({});
    const out = await svc.verify('ws-1', TARGET, '123456');
    expect(out.ok).toBe(false);
    expect(prisma.smsOtpCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('refuses once attempts already reached maxAttempts', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 5 }));
    (prisma.smsOtpCode.update as jest.Mock).mockResolvedValue({});
    const out = await svc.verify('ws-1', TARGET, '123456');
    expect(out.ok).toBe(false);
    expect(prisma.smsOtpCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('an incorrect code increments attempts without consuming the row (attempts remaining)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 1 }));
    (prisma.smsOtpCode.update as jest.Mock).mockResolvedValue({});
    const out = await svc.verify('ws-1', TARGET, '000000');
    expect(out.ok).toBe(false);
    expect(prisma.smsOtpCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { attempts: 2 },
    });
  });

  it('the wrong attempt that TRIPS the cap invalidates the row in the same write', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row({ attempts: 4, maxAttempts: 5 }));
    (prisma.smsOtpCode.update as jest.Mock).mockResolvedValue({});
    const out = await svc.verify('ws-1', TARGET, '000000');
    expect(out.ok).toBe(false);
    expect(prisma.smsOtpCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { attempts: 5, consumedAt: expect.any(Date) },
    });
  });

  it('a correct code verifies once and consumes the row', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row());
    (prisma.smsOtpCode.update as jest.Mock).mockResolvedValue({});
    const out = await svc.verify('ws-1', TARGET, '123456');
    expect(out.ok).toBe(true);
    expect(prisma.smsOtpCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('trims whitespace on the submitted code before hashing', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.smsOtpCode.findFirst as jest.Mock).mockResolvedValue(row());
    (prisma.smsOtpCode.update as jest.Mock).mockResolvedValue({});
    const out = await svc.verify('ws-1', TARGET, '  123456  ');
    expect(out.ok).toBe(true);
  });
});
