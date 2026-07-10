import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TelephonyQueueService } from './telephony-queue.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('TelephonyQueueService', () => {
  let prisma: MockPrismaClient;
  let telephonyConfig: { resolveForWorkspace: jest.Mock; resolveNetasistanForWorkspace: jest.Mock };
  let client: { queueStats: jest.Mock; agentLogin: jest.Mock; agentPause: jest.Mock };
  let netasistan: { getToken: jest.Mock; setBreak: jest.Mock; setQueue: jest.Mock };
  let svc: TelephonyQueueService;

  const WS = 'ws-1';
  const REP_ID = 'rep-1';
  const CREDS = { username: '8508407303', password: 'pw' };
  const NETASISTAN_CREDS = { appKey: 'app-key', userKey: 'user-key' };
  const NETASISTAN_TOKEN = { ok: true, token: 'bearer-xyz', expiresAt: Date.now() + 3_600_000, message: null, retriable: false };

  beforeEach(() => {
    prisma = mockPrismaClient();
    telephonyConfig = {
      resolveForWorkspace: jest.fn().mockResolvedValue(CREDS),
      resolveNetasistanForWorkspace: jest.fn().mockResolvedValue(null),
    };
    client = {
      queueStats: jest.fn().mockResolvedValue({ ok: true, queues: [] }),
      agentLogin: jest.fn().mockResolvedValue({ ok: true }),
      agentPause: jest.fn().mockResolvedValue({ ok: true }),
    };
    netasistan = {
      getToken: jest.fn().mockResolvedValue(NETASISTAN_TOKEN),
      setBreak: jest.fn().mockResolvedValue({ ok: true, message: null, retriable: false }),
      setQueue: jest.fn().mockResolvedValue({ ok: true, message: null, retriable: false }),
    };
    svc = new TelephonyQueueService(prisma as any, telephonyConfig as any, client as any, netasistan as any);
  });

  describe('stats', () => {
    it('resolves creds and returns the parsed queues', async () => {
      const queues = [{ queue: '8508407303-queue-sales', waiting: 2, holdtimeSec: 45, agents: [] }];
      client.queueStats.mockResolvedValue({ ok: true, queues });
      const res = await svc.stats(WS);
      expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledWith(WS);
      expect(client.queueStats).toHaveBeenCalledWith(CREDS, undefined);
      expect(res).toEqual({ queues });
    });

    it('passes a queue name filter through to the client', async () => {
      await svc.stats(WS, '8508407303-queue-sales');
      expect(client.queueStats).toHaveBeenCalledWith(CREDS, '8508407303-queue-sales');
    });

    it('defaults to an empty array when the client omits queues on success', async () => {
      client.queueStats.mockResolvedValue({ ok: true });
      const res = await svc.stats(WS);
      expect(res).toEqual({ queues: [] });
    });

    it('surfaces a netsantral rejection as BadRequestException', async () => {
      client.queueStats.mockResolvedValue({ ok: false, message: 'auth failed' });
      await expect(svc.stats(WS)).rejects.toThrow('auth failed');
    });

    it('503s when the workspace has no active netsantral config', async () => {
      telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
      await expect(svc.stats(WS)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(client.queueStats).not.toHaveBeenCalled();
    });
  });

  describe('setPresence', () => {
    it("calls agentLogin with the rep's OWN dahili for state:'available'", async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104' } as any);
      const res = await svc.setPresence(WS, REP_ID, { state: 'available' });
      expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: REP_ID, workspaceId: WS } }),
      );
      expect(client.agentLogin).toHaveBeenCalledWith(CREDS, '104');
      expect(client.agentPause).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true, state: 'available' });
    });

    it("calls agentPause with the rep's dahili + reason for state:'break'", async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104' } as any);
      const res = await svc.setPresence(WS, REP_ID, { state: 'break', reason: 'Lunch' });
      expect(client.agentPause).toHaveBeenCalledWith(CREDS, '104', 'Lunch');
      expect(client.agentLogin).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true, state: 'break' });
    });

    it('calls agentPause with an undefined reason when none is given', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104' } as any);
      await svc.setPresence(WS, REP_ID, { state: 'break' });
      expect(client.agentPause).toHaveBeenCalledWith(CREDS, '104', undefined);
    });

    it('400s when the rep has no dahili set', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null } as any);
      await expect(svc.setPresence(WS, REP_ID, { state: 'available' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(client.agentLogin).not.toHaveBeenCalled();
    });

    it('400s when the rep row does not exist in this workspace', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue(null);
      await expect(svc.setPresence(WS, REP_ID, { state: 'available' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('surfaces a netsantral rejection as BadRequestException', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104' } as any);
      client.agentLogin.mockResolvedValue({ ok: false, message: 'busy' });
      await expect(svc.setPresence(WS, REP_ID, { state: 'available' })).rejects.toThrow('busy');
    });

    it('503s when the workspace has no active netsantral config', async () => {
      telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
      await expect(svc.setPresence(WS, REP_ID, { state: 'available' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
    });
  });

  /**
   * NetGSM Phase 6 Task 4 — the SAME presence toggle also mirrors to
   * Netasistan self-service break/queue when the rep opted in AND the
   * workspace has Netasistan keys configured. Best-effort: any Netasistan
   * failure must never break the (already-succeeded) santral outcome above.
   */
  describe('setPresence — Netasistan sync (NetGSM Phase 6 Task 4)', () => {
    it('does NOT call Netasistan when the rep has not opted in, even if the workspace has keys configured', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: false } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockResolvedValue(NETASISTAN_CREDS);

      const res = await svc.setPresence(WS, REP_ID, { state: 'available' });

      expect(client.agentLogin).toHaveBeenCalledWith(CREDS, '104');
      expect(telephonyConfig.resolveNetasistanForWorkspace).not.toHaveBeenCalled();
      expect(netasistan.getToken).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true, state: 'available' });
    });

    it('does NOT call Netasistan when the rep opted in but the workspace has no Netasistan keys configured', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: true } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockResolvedValue(null);

      await svc.setPresence(WS, REP_ID, { state: 'available' });

      expect(telephonyConfig.resolveNetasistanForWorkspace).toHaveBeenCalledWith(WS);
      expect(netasistan.getToken).not.toHaveBeenCalled();
    });

    it("calls Netasistan setQueue(join:true) for state:'available' when opted in + keys configured", async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: true } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockResolvedValue(NETASISTAN_CREDS);

      const res = await svc.setPresence(WS, REP_ID, { state: 'available' });

      expect(netasistan.getToken).toHaveBeenCalledWith('app-key', 'user-key');
      expect(netasistan.setQueue).toHaveBeenCalledWith('bearer-xyz', '104', true);
      expect(netasistan.setBreak).not.toHaveBeenCalled();
      // The santral outcome is still the source of truth for the response.
      expect(res).toEqual({ ok: true, state: 'available' });
    });

    it("calls Netasistan setBreak(reason) for state:'break' when opted in + keys configured", async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: true } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockResolvedValue(NETASISTAN_CREDS);

      await svc.setPresence(WS, REP_ID, { state: 'break', reason: 'Lunch' });

      expect(netasistan.setBreak).toHaveBeenCalledWith('bearer-xyz', '104', 'Lunch');
      expect(netasistan.setQueue).not.toHaveBeenCalled();
    });

    it('a Netasistan auth failure does not break the santral presence result', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: true } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockResolvedValue(NETASISTAN_CREDS);
      netasistan.getToken.mockResolvedValue({ ok: false, token: null, expiresAt: null, message: 'bad creds', retriable: false });

      const res = await svc.setPresence(WS, REP_ID, { state: 'available' });

      expect(netasistan.setQueue).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true, state: 'available' });
    });

    it('a Netasistan setQueue/setBreak rejection does not break the santral presence result', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: true } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockResolvedValue(NETASISTAN_CREDS);
      netasistan.setQueue.mockResolvedValue({ ok: false, message: 'agent not found', retriable: false });

      const res = await svc.setPresence(WS, REP_ID, { state: 'available' });

      expect(res).toEqual({ ok: true, state: 'available' });
    });

    it('a thrown Netasistan error does not break the santral presence result', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '104', netasistanOptIn: true } as any);
      telephonyConfig.resolveNetasistanForWorkspace.mockRejectedValue(new Error('boom'));

      const res = await svc.setPresence(WS, REP_ID, { state: 'available' });

      expect(res).toEqual({ ok: true, state: 'available' });
    });
  });
});
