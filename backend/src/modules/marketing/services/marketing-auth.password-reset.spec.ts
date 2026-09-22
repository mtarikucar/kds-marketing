import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { MarketingAuthService } from './marketing-auth.service';
import { MailReceipt } from '../channels/outbound/outbound-mail.types';

/**
 * no-password-recovery.
 *
 * There was no forgot/reset route at all: `change-password` sits behind
 * MarketingGuard and asks for the CURRENT password, so the one person it
 * cannot help is the one who forgot it. An OWNER locked out of a workspace had
 * exactly one path back in — someone editing the database by hand.
 *
 * Three properties the flow has to have, and all three are things the sibling
 * paths in this service already established:
 *  - it leaks nothing (`login` burns a dummy bcrypt compare for exactly this
 *    reason), so an unknown address is answered like a known one;
 *  - it hands back no session. Minting tokens here would walk straight past
 *    the 2FA challenge, the status check, the SYSTEM check and the
 *    ACTIVE-membership check that `login` and `refreshToken` enforce;
 *  - it bumps `tokenVersion`, so a refresh token stolen before the reset dies
 *    with it.
 */
describe('MarketingAuthService — password recovery', () => {
  const receipt = (over: Partial<MailReceipt> = {}): MailReceipt => ({
    outcome: 'SENT',
    ok: true,
    mailLogId: 'ml-1',
    messageId: 'mid@jeetagrowth.com',
    transport: 'PLATFORM',
    retriable: false,
    ...over,
  });

  /** A real bcrypt hash — the 60-char shape `accept()` uses to tell a real
   *  password from the unusable pending-invite sentinel. */
  const HASH = bcrypt.hashSync('OldPassw0rd', 10);

  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u-1',
    workspaceId: 'ws-1',
    email: 'owner@acme.co',
    password: HASH,
    tokenVersion: 3,
    status: 'ACTIVE',
    role: 'OWNER',
    failedLogins: 5,
    lockedUntil: new Date('2026-09-22T10:00:00Z'),
    ...over,
  });

  function make(row: Record<string, unknown> | null = user()) {
    const prisma: any = {
      marketingUser: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
      },
      workspace: { findUnique: jest.fn().mockResolvedValue({ defaultLanguage: 'tr' }) },
      workspaceMembership: { updateMany: jest.fn() },
    };
    const jwt = { sign: jest.fn().mockReturnValue('session-token') };
    const config = {
      get: jest.fn((key: string) =>
        key === 'MARKETING_JWT_SECRET'
          ? 'a-marketing-secret-long-enough-for-hs256'
          : key === 'FRONTEND_URL'
            ? 'https://app.example.com'
            : key === 'BCRYPT_COST'
              ? '10'
              : undefined,
      ),
    };
    const mail = { send: jest.fn().mockResolvedValue(receipt()) };
    const svc = new MarketingAuthService(
      prisma as never,
      jwt as never,
      config as never,
      { issue: jest.fn(), verify: jest.fn() } as never,
      { resolveDefaultWorkspaceId: jest.fn(), getActiveMembership: jest.fn() } as never,
      mail as never,
    );
    return { prisma, svc, mail, jwt, config };
  }

  /** The link the mail carries, as the recipient would copy it. */
  const tokenFromMail = (mail: { send: jest.Mock }): string => {
    const text = mail.send.mock.calls[0][0].text as string;
    const match = text.match(/reset-password\?token=([^\s]+)/);
    if (!match) throw new Error(`no reset link in:\n${text}`);
    return decodeURIComponent(match[1]);
  };

  afterEach(() => jest.restoreAllMocks());

  describe('requestPasswordReset', () => {
    it('answers an unknown address exactly like a known one, and sends nothing', async () => {
      const known = make();
      const unknown = make(null);

      const a = await known.svc.requestPasswordReset('owner@acme.co');
      const b = await unknown.svc.requestPasswordReset('nobody@acme.co');

      // Byte-identical: the body is the only thing an enumerating client sees.
      expect(b).toEqual(a);
      expect(unknown.mail.send).not.toHaveBeenCalled();
    });

    it('mails the link as AUTH — platform identity, no tenant Reply-To, no unsubscribe', async () => {
      const { svc, mail } = make();

      await svc.requestPasswordReset('owner@acme.co');

      const sent = mail.send.mock.calls[0][0];
      expect(sent).toMatchObject({
        workspaceId: 'ws-1',
        // AUTH is gated by nothing a tenant can set: a stale bounce row or a
        // marketing opt-out that silenced this mail would lock the owner out
        // of the product permanently.
        mailClass: 'AUTH',
        to: 'owner@acme.co',
        source: 'auth:password-reset',
      });
      expect(sent.unsubscribe).toBeUndefined();
      expect(sent.leadId).toBeUndefined();
      expect(sent.text).toContain('https://app.example.com/reset-password?token=');
    });

    it('never mails the SYSTEM research sentinel', async () => {
      const { svc, mail } = make(user({ role: 'SYSTEM' }));
      await svc.requestPasswordReset('owner@acme.co');
      // It owns rows, never sessions — and its password is not a password.
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('never mails a pending-invite identity, whose password is an unusable sentinel', async () => {
      const { svc, mail } = make(user({ password: 'NOT-A-BCRYPT-HASH-just-random-bytes' }));
      await svc.requestPasswordReset('owner@acme.co');
      // Setting a real password here would be an accept() that skipped
      // accept(): the membership would stay INVITED while the identity became
      // loginable.
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('never mails a deactivated account', async () => {
      const { svc, mail } = make(user({ status: 'INACTIVE' }));
      await svc.requestPasswordReset('owner@acme.co');
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('still answers normally when the mail cannot go out', async () => {
      const { svc, mail } = make();
      mail.send.mockRejectedValue(new Error('relay down'));
      await expect(svc.requestPasswordReset('owner@acme.co')).resolves.toMatchObject({
        message: expect.any(String),
      });
    });
  });

  describe('resetPassword', () => {
    it('sets the new password, bumps tokenVersion and clears the lockout', async () => {
      const { svc, prisma, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');

      const out = await svc.resetPassword(tokenFromMail(mail), 'BrandNewPass1');

      const update = prisma.marketingUser.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'u-1' });
      // The bump is load-bearing, not cosmetic: refreshToken and the guard
      // both compare the JWT's `ver` to this, so without it the attacker's
      // stolen refresh token outlives the victim's reset.
      expect(update.data.tokenVersion).toEqual({ increment: 1 });
      expect(await bcrypt.compare('BrandNewPass1', update.data.password)).toBe(true);
      // The locked-out owner is the whole point of the flow; leaving the
      // lockout in place would hand them a working password they still cannot
      // use for fifteen minutes.
      expect(update.data.failedLogins).toBe(0);
      expect(update.data.lockedUntil).toBeNull();
      expect(out.message).toEqual(expect.any(String));
    });

    it('hands back no session — the user signs in again', async () => {
      const { svc, mail, jwt } = make();
      await svc.requestPasswordReset('owner@acme.co');

      const out = await svc.resetPassword(tokenFromMail(mail), 'BrandNewPass1');

      // "Reset gives you a session" is the classic 2FA bypass: it skips
      // verify2fa, the status check, the SYSTEM check, the ACTIVE-membership
      // check and assertWorkspaceActive, every one of which login enforces.
      expect(out).not.toHaveProperty('accessToken');
      expect(out).not.toHaveProperty('refreshToken');
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('never touches the membership status', async () => {
      const { svc, prisma, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');
      await svc.resetPassword(tokenFromMail(mail), 'BrandNewPass1');
      expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
    });

    it('is single-use: the same link fails once the password has changed', async () => {
      const { svc, prisma, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');
      const token = tokenFromMail(mail);
      await svc.resetPassword(token, 'BrandNewPass1');

      // The stored password and tokenVersion are inside the signature, so the
      // reset itself is what invalidates the link — no column to clear, and no
      // window in which a forwarded mail still works.
      const after = prisma.marketingUser.update.mock.calls[0][0].data;
      prisma.marketingUser.findUnique.mockResolvedValue(
        user({ password: after.password, tokenVersion: 4 }),
      );

      await expect(svc.resetPassword(token, 'AnotherPass1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('dies with an ordinary password change too', async () => {
      const { svc, prisma, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');
      const token = tokenFromMail(mail);

      prisma.marketingUser.findUnique.mockResolvedValue(
        user({ password: bcrypt.hashSync('ChangedByHand1', 10), tokenVersion: 4 }),
      );

      await expect(svc.resetPassword(token, 'AnotherPass1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('expires', async () => {
      const at = Date.parse('2026-09-22T12:00:00Z');
      const clock = jest.spyOn(Date, 'now').mockReturnValue(at);
      const { svc, prisma, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');
      const token = tokenFromMail(mail);

      clock.mockReturnValue(at + 61 * 60 * 1000);

      await expect(svc.resetPassword(token, 'BrandNewPass1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('refuses a tampered token, a foreign token and a malformed one alike', async () => {
      const { svc, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');
      const token = tokenFromMail(mail);

      const say = async (t: string) => {
        try {
          await svc.resetPassword(t, 'BrandNewPass1');
          return 'accepted';
        } catch (e) {
          return (e as Error).message;
        }
      };

      const tampered = `${token.slice(0, -2)}xy`;
      const foreign = `${token.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

      // One message for every no. Distinguishing "expired" from "wrong" from
      // "no such account" turns the route into an oracle.
      const answers = [await say(tampered), await say(foreign), await say('nonsense')];
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).not.toBe('accepted');
    });

    it('refuses a token whose identity is no longer eligible', async () => {
      const { svc, prisma, mail } = make();
      await svc.requestPasswordReset('owner@acme.co');
      const token = tokenFromMail(mail);

      prisma.marketingUser.findUnique.mockResolvedValue(user({ status: 'INACTIVE' }));

      await expect(svc.resetPassword(token, 'BrandNewPass1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });
  });
});
