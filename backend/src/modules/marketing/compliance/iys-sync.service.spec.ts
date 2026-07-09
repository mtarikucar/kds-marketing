import { IysSyncService } from './iys-sync.service';

function makePrisma() {
  return {
    iysSyncJob: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    channel: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function activeSmsChannel() {
  return { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', status: 'ACTIVE' };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    recipient: '05551112233',
    type: 'MESAJ',
    direction: 'ONAY',
    consentAt: new Date('2026-07-08T10:00:00.000Z'),
    source: 'HS_WEB',
    attempts: 0,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('IysSyncService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let registry: { resolveConfig: jest.Mock };
  let budgeter: { tryTake: jest.Mock };
  let client: { add: jest.Mock };
  let svc: IysSyncService;

  beforeEach(() => {
    prisma = makePrisma();
    registry = { resolveConfig: jest.fn() };
    budgeter = { tryTake: jest.fn().mockReturnValue(true) };
    client = { add: jest.fn() };
    svc = new IysSyncService(prisma as any, registry as any, budgeter as any, client as any);
  });

  describe('enqueueConsent', () => {
    it('creates a PENDING MESAJ/ONAY job when consent is granted', async () => {
      const tx = { iysSyncJob: { create: jest.fn().mockResolvedValue({}) } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: '05551112233',
        direction: 'ONAY',
        source: 'HS_WEB',
        consentAt: new Date('2026-07-08T10:00:00.000Z'),
      });
      expect(tx.iysSyncJob.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          leadId: 'lead-1',
          recipient: '05551112233',
          type: 'MESAJ',
          direction: 'ONAY',
          consentAt: new Date('2026-07-08T10:00:00.000Z'),
          source: 'HS_WEB',
        },
      });
    });

    it('creates a RET job when consent is revoked', async () => {
      const tx = { iysSyncJob: { create: jest.fn().mockResolvedValue({}) } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: '05551112233',
        direction: 'RET',
        source: 'HS_MESAJ',
      });
      expect(tx.iysSyncJob.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ direction: 'RET', type: 'MESAJ', source: 'HS_MESAJ' }) }),
      );
    });

    it('does NOT enqueue when the lead has no phone', async () => {
      const tx = { iysSyncJob: { create: jest.fn() } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: null,
        direction: 'ONAY',
        source: 'HS_WEB',
      });
      expect(tx.iysSyncJob.create).not.toHaveBeenCalled();
    });

    // Phase 2 Task 4 — ANTI-FEEDBACK-LOOP GUARD (critical): a consent change
    // that itself originated from İYS's push-back webhook is tagged
    // `source: 'IYS_<originalSource>'` by ComplianceService. Re-submitting it
    // back to İYS would be a feedback loop, so enqueueConsent must skip
    // creating the job entirely for any such source — regardless of
    // direction/recipient otherwise being valid.
    it('does NOT enqueue (anti-feedback-loop guard) when source is IYS_-prefixed, even with a valid recipient', async () => {
      const tx = { iysSyncJob: { create: jest.fn() } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: '05551112233',
        direction: 'ONAY',
        source: 'IYS_HS_MESAJ',
      });
      expect(tx.iysSyncJob.create).not.toHaveBeenCalled();
    });

    it('does NOT enqueue an IYS_-sourced RET either', async () => {
      const tx = { iysSyncJob: { create: jest.fn() } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: '05551112233',
        direction: 'RET',
        source: 'IYS_HS_WEB',
      });
      expect(tx.iysSyncJob.create).not.toHaveBeenCalled();
    });

    // Final-review MUST-FIX H2: a phone that can never reduce to a TR mobile
    // (a landline, garbage, ...) must never sit as a silently-retrying
    // PENDING row — fail it immediately with an actionable lastError.
    it('creates an immediately-FAILED job with lastError "invalid recipient phone" when the recipient is not a TR mobile', async () => {
      const tx = { iysSyncJob: { create: jest.fn().mockResolvedValue({}) } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: '02121234567', // a landline, not a mobile
        direction: 'ONAY',
        source: 'HS_WEB',
      });
      expect(tx.iysSyncJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipient: '02121234567',
          status: 'FAILED',
          lastError: 'invalid recipient phone',
        }),
      });
    });

    it('still creates a normal PENDING job for a valid phone in another shape (+90/bare-10)', async () => {
      const tx = { iysSyncJob: { create: jest.fn().mockResolvedValue({}) } };
      await svc.enqueueConsent(tx as any, {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        recipient: '+905551112233',
        direction: 'ONAY',
        source: 'HS_WEB',
      });
      const data = tx.iysSyncJob.create.mock.calls[0][0].data;
      expect(data.status).toBeUndefined(); // defaults to PENDING — no override
      expect(data.lastError).toBeUndefined();
    });
  });

  describe('retryDlq', () => {
    it('flips DLQ -> PENDING, attempts=0, lastError cleared, scoped to the workspace', async () => {
      prisma.iysSyncJob.updateMany.mockResolvedValue({ count: 3 } as any);
      const out = await svc.retryDlq('ws-1');
      expect(prisma.iysSyncJob.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', status: 'DLQ' },
        data: { status: 'PENDING', attempts: 0, lastError: null },
      });
      expect(out).toEqual({ count: 3 });
    });
  });

  describe('drain (worker tick)', () => {
    it('returns zero when there are no due jobs', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([]);
      await expect(svc.drain()).resolves.toEqual({ processed: 0, sent: 0 });
      expect(prisma.channel.findMany).not.toHaveBeenCalled();
    });

    it('sends a PENDING job and stamps SENT + refid (matched by order)', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([job()] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockResolvedValue({ ok: true, code: '00', refids: ['ref-1'], message: null });

      const out = await svc.drain();

      expect(client.add).toHaveBeenCalledWith(
        { usercode: 'u1', password: 'p1', brandCode: 'BR1' },
        // recipient is normalized to İYS's canonical 90XXXXXXXXXX wire shape
        // (no `+`), never the raw 0-prefixed phone as stored on the job.
        [{ recipient: '905551112233', type: 'MESAJ', status: 'ONAY', consentDate: '2026-07-08 13:00:00', source: 'HS_WEB' }],
      );
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'SENT', refid: 'ref-1' } });
      expect(out).toEqual({ processed: 1, sent: 1 });
    });

    it('chunks a batch of 501 due jobs into two add() calls (≤500 each)', async () => {
      // Each row needs a real (valid, normalizable) TR mobile — a padded
      // 7-digit suffix keeps every one of the 501 rows distinct and valid.
      const jobs = Array.from({ length: 501 }, (_, i) => job({ id: `job-${i}`, recipient: `0555${String(i).padStart(7, '0')}` }));
      prisma.iysSyncJob.findMany.mockResolvedValue(jobs as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockImplementation(async (_creds: unknown, rows: unknown[]) => ({
        ok: true,
        code: '00',
        refids: rows.map((_, i) => `ref-${i}`),
        message: null,
      }));

      await svc.drain();

      expect(client.add).toHaveBeenCalledTimes(2);
      expect(client.add.mock.calls[0][1]).toHaveLength(500);
      expect(client.add.mock.calls[1][1]).toHaveLength(1);
    });

    it('a budget denial stops further batches this tick, leaving the rest untouched for next tick', async () => {
      const jobs = Array.from({ length: 501 }, (_, i) => job({ id: `job-${i}` }));
      prisma.iysSyncJob.findMany.mockResolvedValue(jobs as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      budgeter.tryTake.mockReturnValueOnce(true).mockReturnValueOnce(false);
      client.add.mockImplementation(async (_creds: unknown, rows: unknown[]) => ({
        ok: true,
        code: '00',
        refids: rows.map((_, i) => `ref-${i}`),
        message: null,
      }));

      const out = await svc.drain();

      expect(client.add).toHaveBeenCalledTimes(1); // second (denied) batch never calls IysClient
      expect(out.processed).toBe(500);
      expect(prisma.iysSyncJob.update).toHaveBeenCalledTimes(500); // only the sent batch stamped — the rest stay PENDING
    });

    it('marks FAILED with lastError "no brandCode" when the ACTIVE SMS channel has creds but no brandCode', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([job()] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: {} });

      await svc.drain();

      expect(client.add).not.toHaveBeenCalled();
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'FAILED', attempts: 1, lastError: 'no brandCode' },
      });
    });

    it('marks FAILED with lastError "no creds" when the workspace has no ACTIVE SMS channel at all', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([job()] as any);
      prisma.channel.findMany.mockResolvedValue([]);

      await svc.drain();

      expect(client.add).not.toHaveBeenCalled();
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'FAILED', attempts: 1, lastError: 'no creds' },
      });
    });

    it('escalates to DLQ once attempts reaches 8 on a NetGSM add() failure', async () => {
      // updatedAt far enough in the past to clear the attempts=7 backoff (capped at 1h).
      prisma.iysSyncJob.findMany.mockResolvedValue([
        job({ attempts: 7, updatedAt: new Date(Date.now() - 3_600_000 - 1_000) }),
      ] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockResolvedValue({ ok: false, code: '51', refids: [], message: 'İYS reddetti' });

      await svc.drain();

      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'DLQ', attempts: 8, lastError: 'İYS reddetti' },
      });
    });

    it('a FAILED job whose backoff has NOT elapsed yet is not re-picked this tick', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([
        job({ status: 'FAILED', attempts: 1, updatedAt: new Date(Date.now() - 10_000) }), // 10s ago, needs 60s
      ] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);

      const out = await svc.drain();

      expect(client.add).not.toHaveBeenCalled();
      expect(out).toEqual({ processed: 0, sent: 0 });
    });

    it('a FAILED job whose backoff HAS elapsed is re-picked and retried', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([
        job({ status: 'FAILED', attempts: 1, updatedAt: new Date(Date.now() - 61_000) }), // 61s ago, needs 60s
      ] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockResolvedValue({ ok: true, code: '00', refids: ['ref-2'], message: null });

      await svc.drain();

      expect(client.add).toHaveBeenCalled();
    });

    it('fails closed (does NOT stamp SENT) when add() returns ok with FEWER refids than rows in the batch', async () => {
      // extractRefids drops any row whose refid key it didn't recognize,
      // which would otherwise shift every later row's stamped refid out of
      // alignment — a silent, non-self-healing consent-proof loss. A short
      // refids array must be treated as a failed attempt instead.
      const jobs = [job({ id: 'job-1' }), job({ id: 'job-2', recipient: '05559998877' })];
      prisma.iysSyncJob.findMany.mockResolvedValue(jobs as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockResolvedValue({ ok: true, code: '00', refids: ['ref-1'], message: null });

      const out = await svc.drain();

      expect(prisma.iysSyncJob.update).toHaveBeenCalledTimes(2);
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'FAILED', attempts: 1, lastError: 'refid count mismatch: expected 2 got 1' },
      });
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-2' },
        data: { status: 'FAILED', attempts: 1, lastError: 'refid count mismatch: expected 2 got 1' },
      });
      // never a SENT stamp on a count mismatch — no row is permanently
      // excluded from re-submission with a null/misattributed refid.
      expect(prisma.iysSyncJob.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
      );
      expect(out).toEqual({ processed: 2, sent: 0 });
    });

    it('escalates a refid count mismatch to DLQ once attempts reaches 8, same as any other failure', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([
        job({ attempts: 7, updatedAt: new Date(Date.now() - 3_600_000 - 1_000) }),
      ] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockResolvedValue({ ok: true, code: '00', refids: [], message: null });

      await svc.drain();

      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'DLQ', attempts: 8, lastError: 'refid count mismatch: expected 1 got 0' },
      });
    });

    it('never throws out of a tick when a workspace lookup fails unexpectedly', async () => {
      prisma.iysSyncJob.findMany.mockResolvedValue([job()] as any);
      prisma.channel.findMany.mockRejectedValue(new Error('db down'));

      await expect(svc.drain()).resolves.toEqual({ processed: 0, sent: 0 });
    });

    // Final-review MUST-FIX H2 (defense in depth): a row whose recipient
    // can't normalize to a TR mobile must never reach /iys/add — enqueueConsent
    // already catches this at insert time, but a pre-existing/legacy row (or
    // one written by some future path) must still fail safely here instead.
    it('marks a job with an unnormalizable recipient FAILED immediately, without ever including it in an /iys/add call', async () => {
      const good = job({ id: 'job-good', recipient: '05551112233' });
      const bad = job({ id: 'job-bad', recipient: '02121234567' }); // landline, not a mobile
      prisma.iysSyncJob.findMany.mockResolvedValue([good, bad] as any);
      prisma.channel.findMany.mockResolvedValue([activeSmsChannel()] as any);
      registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1', password: 'p1' }, public: { brandCode: 'BR1' } });
      client.add.mockResolvedValue({ ok: true, code: '00', refids: ['ref-1'], message: null });

      await svc.drain();

      // Only the valid recipient is ever sent to NetGSM.
      expect(client.add).toHaveBeenCalledTimes(1);
      expect(client.add.mock.calls[0][1]).toEqual([
        { recipient: '905551112233', type: 'MESAJ', status: 'ONAY', consentDate: '2026-07-08 13:00:00', source: 'HS_WEB' },
      ]);
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({ where: { id: 'job-good' }, data: { status: 'SENT', refid: 'ref-1' } });
      expect(prisma.iysSyncJob.update).toHaveBeenCalledWith({
        where: { id: 'job-bad' },
        data: { status: 'FAILED', attempts: 1, lastError: 'invalid recipient phone' },
      });
    });
  });

  describe('dlqCount', () => {
    it('counts DLQ jobs scoped to the workspace', async () => {
      prisma.iysSyncJob.count = jest.fn().mockResolvedValue(4);
      const out = await svc.dlqCount('ws-1');
      expect(prisma.iysSyncJob.count).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1', status: 'DLQ' } });
      expect(out).toEqual({ count: 4 });
    });
  });
});
