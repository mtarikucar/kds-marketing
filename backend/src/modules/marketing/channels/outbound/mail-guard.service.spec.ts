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
    over: {
      workspace?: any;
      verdict?: any;
      reserve?: jest.Mock;
      iys?: any;
      capped?: any;
    } = {},
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
    // The unarmed answer, which is what every workspace sees today: a gap code
    // and no refusal.
    const iysEmail: any = {
      check: jest.fn().mockResolvedValue(over.iys ?? { status: 'UNKNOWN', refusal: null, gap: 'NOT_ARMED' }),
      readiness: jest.fn(),
    };
    const budget: any = {
      reserveDaily: jest.fn().mockResolvedValue(over.capped ?? null),
      refundDaily: jest.fn().mockResolvedValue(undefined),
    };
    return {
      prisma,
      suppression,
      quota,
      iysEmail,
      budget,
      svc: new MailGuardService(prisma, suppression, quota, iysEmail, budget),
    };
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

  describe('İYS EPOSTA', () => {
    it('is not even asked about a mail nobody called commercial', async () => {
      const { iysEmail, svc } = build();
      await svc.check({ mail: mail() });
      expect(iysEmail.check).not.toHaveBeenCalled();
    });

    it('lets commercial mail through while the port has no answer', async () => {
      const { iysEmail, svc } = build();
      await expect(svc.check({ mail: mail({ ticari: true }) })).resolves.toBeNull();
      expect(iysEmail.check).toHaveBeenCalledWith(expect.objectContaining({ address: 'ali@acme.test', ticari: true }));
    });

    it('refuses on a real RET', async () => {
      const { svc } = build({ iys: { status: 'RET', refusal: { reason: 'IYS_RET', retriable: false } } });
      await expect(svc.check({ mail: mail({ ticari: true }) })).resolves.toMatchObject({
        reason: 'IYS_RET',
        retriable: false,
      });
    });

    it('defers rather than burns the recipient when İYS could not answer', async () => {
      const { svc } = build({
        iys: { status: 'UNKNOWN', refusal: { reason: 'TRANSIENT', retriable: true }, gap: 'UNREACHABLE' },
      });
      await expect(svc.check({ mail: mail({ ticari: true }) })).resolves.toMatchObject({
        reason: 'TRANSIENT',
        retriable: true,
      });
    });

    it('hands the port the workspace row the gate already read', async () => {
      const { prisma, iysEmail, svc } = build();
      await svc.check({
        mail: mail({ ticari: true }),
        workspace: { status: 'ACTIVE', settings: { email: { iys: { eposta: true } } } },
      });
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
      expect(iysEmail.check).toHaveBeenCalledWith(
        expect.objectContaining({ settings: { email: { iys: { eposta: true } } } }),
      );
    });

    it('refuses before the quota is spent', async () => {
      const { quota, svc } = build({ iys: { status: 'RET', refusal: { reason: 'IYS_RET', retriable: false } } });
      await svc.check({ mail: mail({ ticari: true }) });
      expect(quota.reserve).not.toHaveBeenCalled();
    });
  });

  describe('the send window', () => {
    // 22:00 local in a zone three hours ahead of UTC — the drip that lands at
    // 02:30 is the finding this gate exists for.
    const LATE = { status: 'ACTIVE', settings: { email: { sendWindow: { from: 9, to: 18 } } }, timezone: 'Europe/Istanbul' };

    it('does nothing for the tenants who have not set one', async () => {
      const { svc } = build();
      await expect(svc.check({ mail: mail() })).resolves.toBeNull();
    });

    it('defers a bulk mail outside the window with a retryAt, never a drop', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-10T22:30:00Z'));
      try {
        const { svc } = build({ workspace: LATE });
        const refusal: any = await svc.check({ mail: mail() });
        expect(refusal).toMatchObject({ reason: 'QUIET_HOURS', retriable: true });
        expect(refusal.retryAt).toBeInstanceOf(Date);
        expect(refusal.retryAt.getTime()).toBeGreaterThan(Date.now());
      } finally {
        jest.useRealTimers();
      }
    });

    it('uses the zone on the workspace the gateway already loaded, without reading it again', async () => {
      // The real send path always passes a workspace, so the guard's own
      // read never runs. The hours-only window — the shape the DSL documents
      // and the one an operator writes — has to resolve against the zone that
      // arrives on THAT object.
      jest.useFakeTimers().setSystemTime(new Date('2026-03-10T22:30:00Z'));
      try {
        const { svc, prisma } = build();
        const refusal: any = await svc.check({ mail: mail(), workspace: LATE });
        expect(refusal).toMatchObject({ reason: 'QUIET_HOURS', retriable: true });
        expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('reads an hours-only window in UTC when that is all the workspace says', async () => {
      // `Workspace.timezone` is `@default("UTC")`, so a tenant who never set a
      // zone gets one anyway. Pinned deliberately: 09:00-18:00 then means
      // 09:00-18:00 UTC, not 09:00-18:00 wherever the customer lives. An
      // operator who wants otherwise puts `tz` on the window itself.
      jest.useFakeTimers().setSystemTime(new Date('2026-03-10T22:30:00Z'));
      try {
        const { svc } = build();
        const refusal: any = await svc.check({
          mail: mail(),
          workspace: { status: 'ACTIVE', settings: { email: { sendWindow: { from: 9, to: 18 } } }, timezone: 'UTC' },
        });
        expect(refusal).toMatchObject({ reason: 'QUIET_HOURS' });
        expect(refusal.retryAt.toISOString()).toContain('2026-03-11T09:');
      } finally {
        jest.useRealTimers();
      }
    });

    it('costs no quota and no daily budget, because the mail has not gone yet', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-10T22:30:00Z'));
      try {
        const { quota, budget, svc } = build({ workspace: LATE });
        await svc.check({ mail: mail() });
        expect(quota.reserve).not.toHaveBeenCalled();
        expect(budget.reserveDaily).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('never holds an invoice the customer is waiting for', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-10T22:30:00Z'));
      try {
        const { svc } = build({ workspace: LATE });
        await expect(
          svc.check({ mail: mail({ mailClass: 'TRANSACTIONAL', unsubscribe: undefined }) }),
        ).resolves.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('the daily platform cap', () => {
    const CAPPED = { scope: 'WORKSPACE', limit: 1000, used: 1000, retryAt: new Date('2026-03-11T00:00:00Z') };

    it('queues forward when the shared relay s day is spent', async () => {
      const { svc } = build({ capped: CAPPED });
      await expect(svc.check({ mail: mail() })).resolves.toMatchObject({
        reason: 'DAILY_CAP',
        retriable: true,
        retryAt: CAPPED.retryAt,
      });
    });

    it('only spends the relay s budget on the relay s own transport', async () => {
      const { budget, svc } = build();
      await svc.check({ mail: mail(), transport: 'MAILBOX_SMTP' });
      expect(budget.reserveDaily).toHaveBeenCalledWith({ workspaceId: 'ws-1', transport: 'MAILBOX_SMTP' });
    });

    it('spends nothing at all for a preflight', async () => {
      const { budget, quota, svc } = build();
      await svc.check({ mail: mail(), skipMetering: true });
      expect(budget.reserveDaily).not.toHaveBeenCalled();
      expect(quota.reserve).not.toHaveBeenCalled();
    });

    it('gives the day back when the meter refuses the same mail one step later', async () => {
      const reserve = jest
        .fn()
        .mockRejectedValue(new ForbiddenException({ code: 'MESSAGES_EXHAUSTED', message: 'limit' }));
      const { budget, svc } = build({ reserve });
      await svc.check({ mail: mail() });
      expect(budget.refundDaily).toHaveBeenCalledWith({ workspaceId: 'ws-1', transport: 'PLATFORM' });
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

    it('gives back the day as well as the message', async () => {
      const { budget, svc } = build();
      await svc.refundQuota(mail(), 'PLATFORM');
      expect(budget.refundDaily).toHaveBeenCalledWith({ workspaceId: 'ws-1', transport: 'PLATFORM' });
    });

    it('refunds the day even for mail the plan never charged for', async () => {
      // A campaign meters its own recipients, so `refundQuota` is a no-op for
      // the message counter — but the relay's day was still spent.
      const { quota, budget, svc } = build();
      await svc.refundQuota(mail({ alreadyMetered: true }), 'PLATFORM');
      expect(quota.refund).not.toHaveBeenCalled();
      expect(budget.refundDaily).toHaveBeenCalled();
    });

    it('never throws a daily-budget refund failure back at the caller', async () => {
      const { budget, svc } = build();
      budget.refundDaily.mockRejectedValue(new Error('db down'));
      await expect(svc.refundQuota(mail(), 'PLATFORM')).resolves.toBeUndefined();
    });
  });
});
