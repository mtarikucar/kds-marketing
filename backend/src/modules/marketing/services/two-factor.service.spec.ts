import { TwoFactorService } from './two-factor.service';
import { generateTotpSecret, generateTotpCode } from '../util/totp';
import { openSecret } from '../../../common/crypto/secret-box.helper';
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

  it('beginEnroll renders the QR server-side as a data URI (no third-party QR service)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
    const out: any = await svc.beginEnroll('u1');
    // The secret-bearing otpauth URI must never be handed to an external QR
    // renderer — the QR is generated here and returned as a self-contained PNG.
    expect(out.qrDataUri).toMatch(/^data:image\/png;base64,/);
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

  describe('TOTP secret is SEALED at rest (secret-box configured)', () => {
    const KEY = Buffer.alloc(32, 9).toString('base64');
    beforeAll(() => (process.env.MARKETING_SECRET_KEY = KEY));
    afterAll(() => delete process.env.MARKETING_SECRET_KEY);

    it('beginEnroll stores the secret SEALED (v1:...), not plaintext', async () => {
      const { prisma, svc } = makeSvc();
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const out: any = await svc.beginEnroll('u1');
      const stored = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data
        .twoFactorSecret as string;
      // Persisted ciphertext, never the raw base32 seed; opens back to it.
      expect(stored.startsWith('v1:')).toBe(true);
      expect(stored).not.toBe(out.secret);
      expect(openSecret(stored)).toBe(out.secret);
    });

    it('enable verifies against a SEALED stored secret', async () => {
      const { prisma, svc } = makeSvc();
      // Simulate a sealed enrollment row.
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const enroll: any = await svc.beginEnroll('u1');
      const sealed = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0].data
        .twoFactorSecret as string;
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: sealed } as any);
      const out: any = await svc.enable('u1', generateTotpCode(enroll.secret));
      expect(out.enabled).toBe(true);
    });

    it('still verifies a LEGACY plaintext secret enrolled before the change', async () => {
      const { prisma, svc } = makeSvc();
      const legacy = generateTotpSecret(); // unsealed, as old rows are stored
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: legacy } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({});
      const out: any = await svc.enable('u1', generateTotpCode(legacy));
      expect(out.enabled).toBe(true);
    });
  });
});
