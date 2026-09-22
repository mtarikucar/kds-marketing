import { MailReceipt } from './outbound-mail.types';
import { MailTraceService } from './mail-trace.service';

/**
 * What the rep sees on the lead's timeline. The row that never existed is the
 * one this is really for: "we did not send this, because they unsubscribed".
 */
describe('MailTraceService', () => {
  const SENT: MailReceipt = {
    outcome: 'SENT',
    ok: true,
    mailLogId: 'ml-1',
    messageId: 'abc@acme.test',
    transport: 'PLATFORM',
    retriable: false,
  };

  const REFUSED: MailReceipt = {
    outcome: 'REFUSED',
    ok: false,
    mailLogId: 'ml-2',
    messageId: null,
    transport: 'NONE',
    reason: 'SUPPRESSED_OPT_OUT',
    userMessage: { key: 'mail.reason.SUPPRESSED_OPT_OUT' },
    retriable: false,
  };

  function build(sentinelId: string | null = 'sys-1') {
    const prisma: any = { leadActivity: { create: jest.fn().mockResolvedValue({ id: 'la-1' }) } };
    const sentinel: any = { resolve: jest.fn().mockResolvedValue(sentinelId) };
    return { prisma, sentinel, svc: new MailTraceService(prisma, sentinel) };
  }

  const base = {
    workspaceId: 'ws-1',
    leadId: 'lead-1',
    mailClass: 'BULK' as const,
    subject: 'Kampanya',
    source: 'campaign:c1',
  };

  it('records a sent bulk mail as a positive EMAIL activity', async () => {
    const { prisma, svc } = build();
    await svc.record({ ...base, receipt: SENT });
    const data = prisma.leadActivity.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: 'EMAIL', outcome: 'POSITIVE', leadId: 'lead-1', createdById: 'sys-1' });
    expect(data.metadata).toMatchObject({ kind: 'mail', outcome: 'SENT', mailLogId: 'ml-1' });
  });

  it('records a refusal — and files it as NEUTRAL, not as a failed send', async () => {
    const { prisma, svc } = build();
    await svc.record({ ...base, receipt: REFUSED });
    const data = prisma.leadActivity.create.mock.calls[0][0].data;
    expect(data.outcome).toBe('NEUTRAL');
    expect(data.metadata).toMatchObject({
      outcome: 'REFUSED',
      reason: 'SUPPRESSED_OPT_OUT',
      userMessage: { key: 'mail.reason.SUPPRESSED_OPT_OUT' },
    });
  });

  it('files a delivery failure as NEGATIVE and keeps the provider words', async () => {
    const { prisma, svc } = build();
    await svc.record({
      ...base,
      receipt: { ...SENT, outcome: 'FAILED_TRANSIENT', ok: false, error: '451 try later', retriable: true },
    });
    const data = prisma.leadActivity.create.mock.calls[0][0].data;
    expect(data.outcome).toBe('NEGATIVE');
    expect(data.description).toBe('451 try later');
  });

  it('writes nothing for a class the matrix keeps off the timeline', async () => {
    const { prisma, svc } = build();
    await svc.record({ ...base, mailClass: 'AUTH', receipt: SENT });
    await svc.record({ ...base, mailClass: 'INTERNAL', receipt: SENT });
    // CONVERSATIONAL is covered by its own Message row; a second activity would
    // double every thread in the stream.
    await svc.record({ ...base, mailClass: 'CONVERSATIONAL', receipt: SENT });
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no lead', async () => {
    const { prisma, svc } = build();
    await svc.record({ ...base, leadId: null, receipt: SENT });
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('skips the row — never invents an author — when the workspace has no SYSTEM user', async () => {
    const { prisma, svc } = build(null);
    await svc.record({ ...base, receipt: SENT });
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('never throws a bookkeeping failure back into the send path', async () => {
    const { prisma, svc } = build();
    prisma.leadActivity.create.mockRejectedValue(new Error('db down'));
    await expect(svc.record({ ...base, receipt: SENT })).resolves.toBeUndefined();
  });
});
