import {
  INBOUND_MAX_ATTEMPTS,
  INBOUND_RETRY_KIND,
  InboundItemService,
} from './inbound-item.service';

/**
 * The ledger exists to answer one support question: "where did my customer's
 * mail go?". So the tests are about what is left behind, not about what was
 * fetched — every examined item leaves a row, a skip says WHY it was skipped,
 * a failure keeps the error and buys itself a bounded number of retries, and
 * when those run out the item is PARKED where a human can see it rather than
 * dropped where nobody can.
 *
 * The other half is the rule that nothing here may break the poller. A ledger
 * write that throws would take down the very ingest it is supposed to be
 * reporting on, so every method swallows its own failures (PLAN G2).
 */
describe('InboundItemService', () => {
  const KEY = {
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    source: 'imap',
    itemKey: '42:1001',
  };

  function build(over: Partial<Record<string, any>> = {}) {
    const row = (o: any = {}) => ({
      id: 'it-1',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      source: 'imap',
      itemKey: '42:1001',
      state: 'NEW',
      attempts: 0,
      ...o,
    });
    const prisma: any = {
      emailInboundItem: {
        upsert: over.upsert ?? jest.fn().mockResolvedValue(row()),
        update: over.update ?? jest.fn().mockImplementation(async (a: any) => row(a.data)),
        findFirst: over.findFirst ?? jest.fn().mockResolvedValue(row()),
        findMany: over.findMany ?? jest.fn().mockResolvedValue([]),
      },
      workspaceMembership: {
        findFirst:
          over.membership ?? jest.fn().mockResolvedValue({ userId: 'u-owner' }),
      },
      marketingNotification: {
        create: over.notify ?? jest.fn().mockResolvedValue({ id: 'n-1' }),
        findFirst: over.pendingNotice ?? jest.fn().mockResolvedValue(null),
      },
    };
    const jobs: any = { schedule: over.schedule ?? jest.fn().mockResolvedValue('job-1') };
    const svc = new InboundItemService(prisma, jobs);
    return { prisma, jobs, svc, row };
  }

  describe('open', () => {
    it('records the examined item as NEW, carrying the workspace', async () => {
      const { prisma, svc } = build();
      await svc.open(KEY, { fromAddress: 'ali@acme.test', subject: 'Teklif' });
      const call = prisma.emailInboundItem.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        channelId_source_itemKey: { channelId: 'ch-1', source: 'imap', itemKey: '42:1001' },
      });
      expect(call.create).toEqual(
        expect.objectContaining({
          workspaceId: 'ws-1',
          channelId: 'ch-1',
          source: 'imap',
          itemKey: '42:1001',
          state: 'NEW',
          fromAddress: 'ali@acme.test',
          subject: 'Teklif',
        }),
      );
    });

    it('does not reset the state of an item that was already settled', async () => {
      const { prisma, svc } = build();
      await svc.open(KEY);
      expect(prisma.emailInboundItem.upsert.mock.calls[0][0].update.state).toBeUndefined();
    });

    it('never lets a ledger failure escape into the poller', async () => {
      const upsert = jest.fn().mockRejectedValue(new Error('db down'));
      const { svc } = build({ upsert });
      await expect(svc.open(KEY)).resolves.toBeNull();
    });
  });

  describe('skipped', () => {
    it('records the reason the mail was not ingested', async () => {
      const { prisma, svc } = build();
      await svc.skipped(KEY, 'policy-not-a-lead', { fromAddress: 'stranger@example.test' });
      const call = prisma.emailInboundItem.upsert.mock.calls[0][0];
      expect(call.create.state).toBe('SKIPPED');
      expect(call.create.reason).toBe('policy-not-a-lead');
      expect(call.update.state).toBe('SKIPPED');
      expect(call.update.reason).toBe('policy-not-a-lead');
    });

    it('clears a stale error when the item finally settles', async () => {
      const { prisma, svc } = build();
      await svc.done(KEY);
      expect(prisma.emailInboundItem.upsert.mock.calls[0][0].update).toEqual(
        expect.objectContaining({ state: 'DONE', lastError: null }),
      );
    });
  });

  describe('failed', () => {
    it('keeps the error and schedules exactly one bounded retry', async () => {
      const upsert = jest
        .fn()
        .mockResolvedValue({ id: 'it-1', workspaceId: 'ws-1', channelId: 'ch-1', source: 'imap', itemKey: '42:1001', state: 'NEW', attempts: 1 });
      const { prisma, jobs, svc } = build({ upsert });

      const ref = await svc.failed(KEY, 'simpleParser exploded');

      expect(ref).toEqual(expect.objectContaining({ id: 'it-1', state: 'FAILED', attempts: 1 }));
      expect(prisma.emailInboundItem.upsert.mock.calls[0][0].update.attempts).toEqual({
        increment: 1,
      });
      expect(prisma.emailInboundItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'FAILED' }) }),
      );
      expect(jobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          kind: INBOUND_RETRY_KIND,
          dedupKey: 'inbound:it-1',
          maxAttempts: INBOUND_MAX_ATTEMPTS,
          payload: { itemId: 'it-1', workspaceId: 'ws-1' },
        }),
      );
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
    });

    it('parks the item and tells the owner once the attempts are spent', async () => {
      const upsert = jest.fn().mockResolvedValue({
        id: 'it-1',
        workspaceId: 'ws-1',
        channelId: 'ch-1',
        source: 'imap',
        itemKey: '42:1001',
        state: 'FAILED',
        attempts: INBOUND_MAX_ATTEMPTS,
      });
      const { prisma, jobs, svc } = build({ upsert });

      const ref = await svc.failed(KEY, 'connection reset', { fromAddress: 'ali@acme.test' });

      expect(ref?.state).toBe('QUARANTINED');
      expect(prisma.emailInboundItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'QUARANTINED' }) }),
      );
      expect(jobs.schedule).not.toHaveBeenCalled();
      expect(prisma.marketingNotification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1',
            userId: 'u-owner',
            metadata: expect.objectContaining({ channelId: 'ch-1', itemId: 'it-1' }),
          }),
        }),
      );
    });

    it('does not re-park or re-notify an item a human has already been told about', async () => {
      const upsert = jest.fn().mockResolvedValue({
        id: 'it-1',
        workspaceId: 'ws-1',
        channelId: 'ch-1',
        source: 'imap',
        itemKey: '42:1001',
        state: 'QUARANTINED',
        attempts: 9,
      });
      const { prisma, jobs, svc } = build({ upsert });

      const ref = await svc.failed(KEY, 'still broken');

      expect(ref?.state).toBe('QUARANTINED');
      expect(jobs.schedule).not.toHaveBeenCalled();
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
    });

    it('still records the failure when the retry cannot be scheduled', async () => {
      const schedule = jest.fn().mockRejectedValue(new Error('queue down'));
      const { prisma, svc } = build({ schedule });
      await expect(svc.failed(KEY, 'boom')).resolves.toEqual(
        expect.objectContaining({ state: 'FAILED' }),
      );
      expect(prisma.emailInboundItem.upsert).toHaveBeenCalled();
    });

    it('truncates a novel-length provider error', async () => {
      const { prisma, svc } = build();
      await svc.failed(KEY, 'x'.repeat(2000));
      expect(prisma.emailInboundItem.upsert.mock.calls[0][0].create.lastError).toHaveLength(500);
    });
  });

  describe('facts', () => {
    it('does not wipe what an earlier examination already learned', async () => {
      const { prisma, svc } = build();
      // A retry that dies before parsing knows the uid and nothing else; the
      // from/subject recorded on the first pass are what make the row readable.
      await svc.failed(KEY, 'socket hang up');
      const update = prisma.emailInboundItem.upsert.mock.calls[0][0].update;
      expect('fromAddress' in update).toBe(false);
      expect('subject' in update).toBe(false);
    });
  });

  describe('retry', () => {
    it('re-arms exactly that item and queues its replay', async () => {
      const { prisma, jobs, svc } = build();
      svc.registerReplayer('imap', async () => undefined);

      const r = await svc.retry('ws-1', 'it-1');

      expect(r.ok).toBe(true);
      expect(prisma.emailInboundItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'it-1', workspaceId: 'ws-1' } }),
      );
      expect(prisma.emailInboundItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ state: 'NEW', attempts: 0, lastError: null }),
        }),
      );
      expect(jobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: INBOUND_RETRY_KIND, dedupKey: 'inbound:it-1' }),
      );
    });

    it('refuses an item belonging to another workspace', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const { jobs, svc } = build({ findFirst });
      svc.registerReplayer('imap', async () => undefined);
      await expect(svc.retry('ws-2', 'it-1')).resolves.toEqual({ ok: false, reason: 'not-found' });
      expect(jobs.schedule).not.toHaveBeenCalled();
    });

    it('says so rather than queueing a replay nothing can perform', async () => {
      const { jobs, svc } = build();
      await expect(svc.retry('ws-1', 'it-1')).resolves.toEqual({
        ok: false,
        reason: 'no-replayer',
      });
      expect(jobs.schedule).not.toHaveBeenCalled();
    });
  });

  describe('quarantine', () => {
    it('parks the item and notifies once', async () => {
      const findFirst = jest.fn().mockResolvedValue({
        id: 'it-1',
        workspaceId: 'ws-1',
        channelId: 'ch-1',
        source: 'imap',
        itemKey: '42:1001',
        state: 'FAILED',
        attempts: 3,
        fromAddress: 'ali@acme.test',
        subject: 'Teklif',
      });
      const { prisma, svc } = build({ findFirst });
      await svc.quarantine('ws-1', 'it-1', 'gave up');
      expect(prisma.emailInboundItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'QUARANTINED' }) }),
      );
      expect(prisma.marketingNotification.create).toHaveBeenCalled();
    });

    it('is a no-op on an item that got through in the meantime', async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'it-1', workspaceId: 'ws-1', channelId: 'ch-1', source: 'imap', itemKey: '42:1001', state: 'DONE', attempts: 1 });
      const { prisma, svc } = build({ findFirst });
      await svc.quarantine('ws-1', 'it-1', 'gave up');
      expect(prisma.emailInboundItem.update).not.toHaveBeenCalled();
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
    });

    it('rings the bell once per mailbox, not once per mail in the backlog', async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'it-2', workspaceId: 'ws-1', channelId: 'ch-1', source: 'imap', itemKey: '42:1002', state: 'FAILED', attempts: 3 });
      const pendingNotice = jest.fn().mockResolvedValue({ id: 'n-earlier' });
      const { prisma, svc } = build({ findFirst, pendingNotice });
      await svc.quarantine('ws-1', 'it-2', 'mailbox unreachable');
      // The row is still parked — only the duplicate bell is suppressed.
      expect(prisma.emailInboundItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'QUARANTINED' }) }),
      );
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
    });

    it('does not fail when the workspace has no active owner to tell', async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'it-1', workspaceId: 'ws-1', channelId: 'ch-1', source: 'imap', itemKey: '42:1001', state: 'FAILED', attempts: 3 });
      const membership = jest.fn().mockResolvedValue(null);
      const { prisma, svc } = build({ findFirst, membership });
      await expect(svc.quarantine('ws-1', 'it-1', 'gave up')).resolves.toBeUndefined();
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
    });
  });

  describe('listForChannel', () => {
    it('reads one channel inside one workspace, newest first', async () => {
      const { prisma, svc } = build();
      await svc.listForChannel('ws-1', 'ch-1', { state: 'QUARANTINED', limit: 500 });
      const call = prisma.emailInboundItem.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ workspaceId: 'ws-1', channelId: 'ch-1', state: 'QUARANTINED' });
      expect(call.orderBy).toEqual({ updatedAt: 'desc' });
      expect(call.take).toBe(100);
    });

    it('answers with an empty list rather than throwing when the read fails', async () => {
      const findMany = jest.fn().mockRejectedValue(new Error('db down'));
      const { svc } = build({ findMany });
      await expect(svc.listForChannel('ws-1', 'ch-1')).resolves.toEqual([]);
    });
  });

  describe('replayers', () => {
    it('hands back the replayer registered for a source and nothing for the rest', () => {
      const { svc } = build();
      const fn = jest.fn();
      svc.registerReplayer('imap', fn);
      expect(svc.replayerFor('imap')).toBe(fn);
      expect(svc.replayerFor('webhook')).toBeUndefined();
    });
  });
});
