import { ForbiddenException } from '@nestjs/common';
import { MailGuardService } from './mail-guard.service';
import { OutboundMail } from './outbound-mail.types';

/**
 * The ordered gate. Two properties matter more than any single rule:
 *
 *  - a refusal costs NO quota (suppression is asked before metering), and
 *  - nothing here throws, because a thrown step fails a whole workflow run.
 */
describe('MailGuardService', () => {
  const UNSUB = { token: 'tok', url: 'https://app.test/api/public/ul/tok' };

  function mail(over: Partial<OutboundMail> = {}): OutboundMail {
    return {
      workspaceId: 'ws-1',
      mailClass: 'BULK',
      to: 'ali@acme.test',
      subject: 'Kampanya',
      text: 'merhaba',
      source: 'campaign:c1',
      unsubscribe: UNSUB,
      ...over,
    };
  }

  function build(
    over: { workspace?: any; verdict?: any; reserve?: jest.Mock } = {},
  ) {
    const prisma: any = {
      workspace: {
        findUnique: jest
          .fn()
          .mockResolvedValue(over.workspace === undefined ? { status: 'ACTIVE', settings: null } : over.workspace),
      },
    };
    const suppression: any = {
      check: jest.fn().mockResolvedValue(over.verdict ?? { suppressed: false }),
    };
    const quota: any = {
      reserve: over.reserve ?? jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    };
    return { prisma, suppression, quota, svc: new MailGuardService(prisma, suppression, quota) };
  }

  it('lets a clean bulk mail through and meters it', async () => {
    const { quota, svc } = build();
    await expect(svc.check({ mail: mail() })).resolves.toBeNull();
    expect(quota.reserve).toHaveBeenCalledWith('ws-1', 'EMAIL');
  });

  describe('recipient', () => {
    it('refuses an empty recipient', async () => {
      const { svc } = build();
      await expect(svc.check({ mail: mail({ to: '  ' }) })).resolves.toMatchObject({ reason: 'NO_RECIPIENT' });
    });

    it('refuses a comma list', async () => {
      const { svc } = build();
      await expect(svc.check({ mail: mail({ to: 'a@x.test, b@y.test' }) })).resolves.toMatchObject({
        reason: 'BAD_RECIPIENT',
      });
    });

    it('refuses a CR/LF header injection', async () => {
      const { svc } = build();
      await expect(svc.check({ mail: mail({ to: 'a@x.test\r\nBcc: victim@y.test' }) })).resolves.toMatchObject({
        reason: 'BAD_RECIPIENT',
      });
    });
  });

  describe('bulk fails closed without an unsubscribe', () => {
    it('refuses BULK with no unsubscribe at all', async () => {
      const { quota, svc } = build();
      await expect(svc.check({ mail: mail({ unsubscribe: undefined }) })).resolves.toMatchObject({
        reason: 'NO_UNSUBSCRIBE',
        retriable: false,
      });
      expect(quota.reserve).not.toHaveBeenCalled();
    });

    it('refuses BULK whose link is not one a client can follow', async () => {
      const { svc } = build();
      await expect(
        svc.check({ mail: mail({ unsubscribe: { token: 'tok', url: '/api/public/ul/tok' } }) }),
      ).resolves.toMatchObject({ reason: 'NO_UNSUBSCRIBE' });
    });

    it('never asks a transactional mail for one', async () => {
      const { svc } = build();
      await expect(
        svc.check({ mail: mail({ mailClass: 'TRANSACTIONAL', unsubscribe: undefined }) }),
      ).resolves.toBeNull();
    });
  });

  describe('kill switches', () => {
    it('stops the tenant mail of a suspended workspace', async () => {
      const { svc } = build({ workspace: { status: 'SUSPENDED', settings: null } });
      await expect(svc.check({ mail: mail() })).resolves.toMatchObject({ reason: 'WORKSPACE_INACTIVE' });
    });

    it('never stops account or product mail', async () => {
      const { svc } = build({ workspace: { status: 'SUSPENDED', settings: { email: { paused: true } } } });
      await expect(svc.check({ mail: mail({ mailClass: 'AUTH', unsubscribe: undefined }) })).resolves.toBeNull();
      await expect(svc.check({ mail: mail({ mailClass: 'INTERNAL', unsubscribe: undefined }) })).resolves.toBeNull();
    });

    it('honours the operator pause switch', async () => {
      const { svc } = build({ workspace: { status: 'ACTIVE', settings: { email: { paused: true } } } });
      await expect(svc.check({ mail: mail() })).resolves.toMatchObject({ reason: 'SENDING_PAUSED' });
    });

    it('treats an absent switch as today s behaviour', async () => {
      const { svc } = build({ workspace: { status: 'ACTIVE', settings: { email: {} } } });
      await expect(svc.check({ mail: mail() })).resolves.toBeNull();
    });

    it('uses the workspace the gateway already loaded instead of re-reading it', async () => {
      const { prisma, svc } = build();
      await svc.check({ mail: mail(), workspace: { status: 'ACTIVE', settings: null } });
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });

    it('carries on when the kill-switch read itself fails', async () => {
      const { prisma, svc } = build();
      prisma.workspace.findUnique.mockRejectedValue(new Error('db down'));
      await expect(svc.check({ mail: mail() })).resolves.toBeNull();
    });
  });

  describe('suppression', () => {
    it('refuses a suppressed recipient and spends no quota', async () => {
      const { quota, svc } = build({ verdict: { suppressed: true, reason: 'OPT_OUT' } });
      await expect(svc.check({ mail: mail() })).resolves.toMatchObject({ reason: 'SUPPRESSED_OPT_OUT' });
      expect(quota.reserve).not.toHaveBeenCalled();
    });

    it('maps each suppression reason onto its own code', async () => {
      for (const [reason, code] of [
        ['ERASURE', 'SUPPRESSED_ERASED'],
        ['HARD_BOUNCE', 'SUPPRESSED_BOUNCE'],
        ['INVALID', 'SUPPRESSED_INVALID'],
        ['COMPLAINT', 'SUPPRESSED_COMPLAINT'],
        ['MANUAL', 'SUPPRESSED_OPT_OUT'],
      ] as const) {
        const { svc } = build({ verdict: { suppressed: true, reason } });
        await expect(svc.check({ mail: mail() })).resolves.toMatchObject({ reason: code });
      }
    });

    it('passes the reply context through so an answer is not refused', async () => {
      const { suppression, svc } = build();
      await svc.check({
        mail: mail({ mailClass: 'CONVERSATIONAL', unsubscribe: undefined, proactive: false, thread: { conversationId: 'cv-1' } }),
      });
      expect(suppression.check).toHaveBeenCalledWith('ws-1', 'ali@acme.test', 'CONVERSATIONAL', {
        proactive: false,
        conversationId: 'cv-1',
      });
    });

    it('also asks about the lead s stored address when it was edited since', async () => {
      const { suppression, svc } = build();
      suppression.check
        .mockResolvedValueOnce({ suppressed: false })
        .mockResolvedValueOnce({ suppressed: true, reason: 'OPT_OUT' });
      await expect(
        svc.check({ mail: mail(), lead: { id: 'lead-1', emailNormalized: 'old@acme.test' } }),
      ).resolves.toMatchObject({ reason: 'SUPPRESSED_OPT_OUT' });
      expect(suppression.check).toHaveBeenCalledTimes(2);
    });

    it('does not ask at all for a class no suppression can stop', async () => {
      const { suppression, svc } = build();
      await svc.check({ mail: mail({ mailClass: 'INTERNAL', unsubscribe: undefined }) });
      expect(suppression.check).not.toHaveBeenCalled();
    });

    it('still asks for account mail, because an erasure tombstone stops even that', async () => {
      const { suppression, svc } = build();
      await svc.check({ mail: mail({ mailClass: 'AUTH', unsubscribe: undefined }) });
      expect(suppression.check).toHaveBeenCalledTimes(1);
    });

    it('asks once when the two addresses are the same', async () => {
      const { suppression, svc } = build();
      await svc.check({ mail: mail(), lead: { id: 'lead-1', emailNormalized: 'ali@acme.test' } });
      expect(suppression.check).toHaveBeenCalledTimes(1);
    });
  });

  describe('metering', () => {
    it('turns an exhausted quota into a refusal instead of a throw', async () => {
      const reserve = jest
        .fn()
        .mockRejectedValue(new ForbiddenException({ code: 'MESSAGES_EXHAUSTED', message: 'Monthly message limit reached (0)' }));
      const { svc } = build({ reserve });
      await expect(svc.check({ mail: mail() })).resolves.toMatchObject({
        reason: 'QUOTA_EXHAUSTED',
        retriable: false,
      });
    });

    it('calls a meter failure transient, not a policy refusal', async () => {
      const reserve = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const { svc } = build({ reserve });
      await expect(svc.check({ mail: mail() })).resolves.toMatchObject({ reason: 'TRANSIENT', retriable: true });
    });

    it('does not meter a caller that already reserved its own', async () => {
      const { quota, svc } = build();
      await svc.check({ mail: mail({ alreadyMetered: true }) });
      expect(quota.reserve).not.toHaveBeenCalled();
    });

    it('does not meter our own product mail', async () => {
      const { quota, svc } = build();
      await svc.check({ mail: mail({ mailClass: 'AUTH', unsubscribe: undefined }) });
      await svc.check({ mail: mail({ mailClass: 'INTERNAL', unsubscribe: undefined }) });
      expect(quota.reserve).not.toHaveBeenCalled();
    });
  });

  describe('refundQuota', () => {
    it('gives back what a failed send took', async () => {
      const { quota, svc } = build();
      await svc.refundQuota(mail());
      expect(quota.refund).toHaveBeenCalledWith('ws-1', 'EMAIL');
    });

    it('leaves the campaign sender s own accounting alone', async () => {
      const { quota, svc } = build();
      await svc.refundQuota(mail({ alreadyMetered: true }));
      await svc.refundQuota(mail({ mailClass: 'INTERNAL' }));
      expect(quota.refund).not.toHaveBeenCalled();
    });

    it('never throws a refund failure back at the caller', async () => {
      const { quota, svc } = build();
      quota.refund.mockRejectedValue(new Error('db down'));
      await expect(svc.refundQuota(mail())).resolves.toBeUndefined();
    });
  });
});
