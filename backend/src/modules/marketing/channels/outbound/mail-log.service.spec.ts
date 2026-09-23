import { MailLogService } from './mail-log.service';

/**
 * The ledger has to be right about three things: a refusal leaves a row, a
 * repeat under the same key does not send twice, and nothing it does can stop
 * a mail going out.
 */
describe('MailLogService', () => {
  const BASE = {
    workspaceId: 'ws-1',
    mailClass: 'BULK' as const,
    source: 'campaign:c1',
    to: 'Ali@Acme.test',
    toNorm: 'ali@acme.test',
    fromAddress: 'no-reply@jeetagrowth.com',
    transport: 'PLATFORM' as const,
    subject: 'Kampanya',
  };

  function build(over: { create?: any; findFirst?: any } = {}) {
    const prisma: any = {
      mailLog: {
        create: over.create ?? jest.fn().mockResolvedValue({ id: 'ml-1', workspaceId: 'ws-1', status: 'PENDING', messageId: null }),
        findFirst: over.findFirst ?? jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { prisma, svc: new MailLogService(prisma) };
  }

  describe('pending', () => {
    it('opens a PENDING row carrying the workspace', async () => {
      const { prisma, svc } = build();
      const r = await svc.pending(BASE);
      expect(r.deduped).toBe(false);
      expect(r.row.id).toBe('ml-1');
      expect(prisma.mailLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1',
            status: 'PENDING',
            toAddress: 'Ali@Acme.test',
            toAddressNorm: 'ali@acme.test',
          }),
        }),
      );
    });

    it('opens a refusal closed, in one write', async () => {
      const { prisma, svc } = build();
      await svc.pending({ ...BASE, outcome: 'REFUSED', reason: 'SUPPRESSED_OPT_OUT' });
      const data = prisma.mailLog.create.mock.calls[0][0].data;
      expect(data.status).toBe('REFUSED');
      expect(data.reason).toBe('SUPPRESSED_OPT_OUT');
      expect(prisma.mailLog.updateMany).not.toHaveBeenCalled();
    });

    it('truncates the provider error to 300 characters', async () => {
      const { prisma, svc } = build();
      await svc.pending({ ...BASE, outcome: 'FAILED_PERMANENT', error: 'x'.repeat(500) });
      expect(prisma.mailLog.create.mock.calls[0][0].data.error).toHaveLength(300);
    });

    it('reports DEDUPED when the key already produced a sent mail', async () => {
      const create = jest.fn().mockRejectedValue({ code: 'P2002' });
      const findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'ml-old', workspaceId: 'ws-1', status: 'SENT', messageId: 'a@b.test' });
      const { svc } = build({ create, findFirst });
      const r = await svc.pending({ ...BASE, idempotencyKey: 'wf:r1:s1:l1' });
      expect(r).toEqual({ deduped: true, row: { id: 'ml-old', workspaceId: 'ws-1', status: 'SENT', messageId: 'a@b.test' } });
    });

    it('reuses the row when the earlier attempt under that key never got out', async () => {
      const create = jest.fn().mockRejectedValue({ code: 'P2002' });
      const findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'ml-old', workspaceId: 'ws-1', status: 'FAILED_TRANSIENT', messageId: null });
      const { prisma, svc } = build({ create, findFirst });
      const r = await svc.pending({ ...BASE, idempotencyKey: 'wf:r1:s1:l1' });
      expect(r.deduped).toBe(false);
      expect(r.row.id).toBe('ml-old');
      expect(prisma.mailLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ml-old', workspaceId: 'ws-1' },
          data: expect.objectContaining({ status: 'PENDING', attempts: { increment: 1 } }),
        }),
      );
    });

    it('treats a row another send is still dispatching as a duplicate, not a retry', async () => {
      // The row the winner opened stays PENDING for the WHOLE round-trip — the
      // gateway opens it before the dispatch and settles it after — so a loser
      // that read "not delivered yet" and called it a retry would dispatch the
      // same mail a second time. One booking cancellation, two cancellation
      // mails, and a ledger showing a single SENT row with attempts: 2.
      const create = jest.fn().mockRejectedValue({ code: 'P2002' });
      const findFirst = jest.fn().mockResolvedValue({
        id: 'ml-old',
        workspaceId: 'ws-1',
        status: 'PENDING',
        messageId: null,
        transport: 'PLATFORM',
        updatedAt: new Date(Date.now() - 2_000),
      });
      const { prisma, svc } = build({ create, findFirst });
      const r = await svc.pending({ ...BASE, idempotencyKey: 'booking:b1:cancelled' });
      expect(r.deduped).toBe(true);
      expect(r.row.id).toBe('ml-old');
      // Not a retry: the attempt counter does not move and the winner's row is
      // left exactly as it is, so the winner still owns settling it.
      expect(prisma.mailLog.updateMany).not.toHaveBeenCalled();
    });

    it('reopens a PENDING row the process died holding', async () => {
      // The other half: a claim nobody is dispatching any more. Past the
      // in-flight window it is a stranded row, and refusing to retry it would
      // strand the mail with it.
      const create = jest.fn().mockRejectedValue({ code: 'P2002' });
      const findFirst = jest.fn().mockResolvedValue({
        id: 'ml-old',
        workspaceId: 'ws-1',
        status: 'PENDING',
        messageId: null,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      });
      const { prisma, svc } = build({ create, findFirst });
      const r = await svc.pending({ ...BASE, idempotencyKey: 'booking:b1:cancelled' });
      expect(r.deduped).toBe(false);
      expect(prisma.mailLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ attempts: { increment: 1 } }) }),
      );
    });

    it('reads the timestamp it needs to tell the two apart', async () => {
      const create = jest.fn().mockRejectedValue({ code: 'P2002' });
      const findFirst = jest.fn().mockResolvedValue(null);
      const { prisma, svc } = build({ create, findFirst });
      await svc.pending({ ...BASE, idempotencyKey: 'k' });
      expect(prisma.mailLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ updatedAt: true }) }),
      );
    });

    it('hands back an id-less row rather than throwing when the ledger is down', async () => {
      const create = jest.fn().mockRejectedValue(new Error('db down'));
      const { svc } = build({ create });
      const r = await svc.pending(BASE);
      expect(r.deduped).toBe(false);
      expect(r.row.id).toBe('');
    });
  });

  describe('claim', () => {
    it('answers only for a mail the recipient already has', async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: 'ml-1', workspaceId: 'ws-1', status: 'SENT', messageId: null });
      const { svc } = build({ findFirst });
      await expect(svc.claim('ws-1', 'k')).resolves.toMatchObject({ id: 'ml-1' });
    });

    it('ignores a row that was refused or failed', async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: 'ml-1', workspaceId: 'ws-1', status: 'REFUSED', messageId: null });
      const { svc } = build({ findFirst });
      await expect(svc.claim('ws-1', 'k')).resolves.toBeNull();
    });

    it('never reads without a key', async () => {
      const { prisma, svc } = build();
      await expect(svc.claim('ws-1', '')).resolves.toBeNull();
      expect(prisma.mailLog.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('settle', () => {
    it('is workspace-scoped as well as id-keyed', async () => {
      const { prisma, svc } = build();
      await svc.settle({ id: 'ml-1', workspaceId: 'ws-1', status: 'PENDING', messageId: null }, {
        outcome: 'SENT',
        messageId: 'abc@acme.test',
      });
      const call = prisma.mailLog.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'ml-1', workspaceId: 'ws-1' });
      expect(call.data.status).toBe('SENT');
      expect(call.data.messageId).toBe('abc@acme.test');
      expect(call.data.sentAt).toBeInstanceOf(Date);
    });

    it('does nothing for an id-less row', async () => {
      const { prisma, svc } = build();
      await svc.settle({ id: '', workspaceId: 'ws-1' }, { outcome: 'SENT' });
      expect(prisma.mailLog.updateMany).not.toHaveBeenCalled();
    });

    it('swallows a write failure', async () => {
      const { prisma, svc } = build();
      prisma.mailLog.updateMany.mockRejectedValue(new Error('db down'));
      await expect(
        svc.settle({ id: 'ml-1', workspaceId: 'ws-1' }, { outcome: 'FAILED_TRANSIENT' }),
      ).resolves.toBeUndefined();
    });
  });
});
