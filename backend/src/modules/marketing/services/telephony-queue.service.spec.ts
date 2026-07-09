import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TelephonyQueueService } from './telephony-queue.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('TelephonyQueueService', () => {
  let prisma: MockPrismaClient;
  let telephonyConfig: { resolveForWorkspace: jest.Mock };
  let client: { queueStats: jest.Mock; agentLogin: jest.Mock; agentPause: jest.Mock };
  let svc: TelephonyQueueService;

  const WS = 'ws-1';
  const REP_ID = 'rep-1';
  const CREDS = { username: '8508407303', password: 'pw' };

  beforeEach(() => {
    prisma = mockPrismaClient();
    telephonyConfig = { resolveForWorkspace: jest.fn().mockResolvedValue(CREDS) };
    client = {
      queueStats: jest.fn().mockResolvedValue({ ok: true, queues: [] }),
      agentLogin: jest.fn().mockResolvedValue({ ok: true }),
      agentPause: jest.fn().mockResolvedValue({ ok: true }),
    };
    svc = new TelephonyQueueService(prisma as any, telephonyConfig as any, client as any);
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
});
