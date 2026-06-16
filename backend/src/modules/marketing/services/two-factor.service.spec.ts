import { TwoFactorService } from './two-factor.service';
import { generateTotpSecret, generateTotpCode } from '../util/totp';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new TwoFactorService(prisma as any) };
}

describe('TwoFactorService', () => {
  it('beginEnroll stores a secret and returns an otpauth URI', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.beginEnroll('u1');
    expect(out.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data.twoFactorSecret).toBe(out.secret);
  });

  it('enable verifies a TOTP code, flips the flag, and issues backup codes', async () => {
    const { prisma, svc } = makeSvc();
    const secret = generateTotpSecret();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: secret } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.enable('u1', generateTotpCode(secret));
    expect(out.enabled).toBe(true);
    expect(out.backupCodes).toHaveLength(10);
    expect((prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data.twoFactorEnabled).toBe(true);
  });

  it('disable verifies a code then clears 2FA', async () => {
    const { prisma, svc } = makeSvc();
    const secret = generateTotpSecret();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: secret, twoFactorBackupCodes: [] } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.disable('u1', generateTotpCode(secret));
    expect(out.enabled).toBe(false);
    expect((prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data.twoFactorEnabled).toBe(false);
  });

  it('status reports the flag', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true } as any);
    expect(await svc.status('u1')).toEqual({ enabled: true });
  });
});
