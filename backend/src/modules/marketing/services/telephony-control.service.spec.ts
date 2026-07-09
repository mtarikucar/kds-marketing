import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { TelephonyControlService } from './telephony-control.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { MarketingUserPayload } from '../types';

describe('TelephonyControlService', () => {
  let prisma: MockPrismaClient;
  let telephonyConfig: { resolveForWorkspace: jest.Mock };
  let client: { hangup: jest.Mock; blindTransfer: jest.Mock; attendedTransfer: jest.Mock; mute: jest.Mock };
  let svc: TelephonyControlService;

  const WS = 'ws-1';
  const CREDS = { username: '8508407303', password: 'pw' };
  const REP: MarketingUserPayload = { id: 'rep-1', workspaceId: WS, email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'REP', status: 'ACTIVE' };
  const MANAGER: MarketingUserPayload = { ...REP, id: 'mgr-1', role: 'MANAGER' };

  beforeEach(() => {
    prisma = mockPrismaClient();
    telephonyConfig = { resolveForWorkspace: jest.fn().mockResolvedValue(CREDS) };
    client = {
      hangup: jest.fn().mockResolvedValue({ ok: true }),
      blindTransfer: jest.fn().mockResolvedValue({ ok: true }),
      attendedTransfer: jest.fn().mockResolvedValue({ ok: true }),
      mute: jest.fn().mockResolvedValue({ ok: true }),
    };
    svc = new TelephonyControlService(prisma as any, telephonyConfig as any, client as any);
  });

  const liveCall = (overrides: Partial<{ id: string; workspaceId: string; marketingUserId: string | null; answeredByUserId: string | null; externalCallId: string | null }> = {}) => ({
    id: 'call-1',
    workspaceId: WS,
    marketingUserId: REP.id,
    answeredByUserId: null,
    externalCallId: 'u-live-1',
    ...overrides,
  });

  describe('resolveLiveCall guard (shared by hangup/transfer/mute)', () => {
    it('404s when the call does not exist in this workspace', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(null);
      await expect(svc.hangup(WS, 'call-x', REP)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("403s when a REP tries to control another rep's call (not the owner, nor the one who answered it)", async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall({ marketingUserId: 'someone-else', answeredByUserId: null }) as any);
      await expect(svc.hangup(WS, 'call-1', REP)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("allows a MANAGER to control another rep's call", async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall({ marketingUserId: 'someone-else' }) as any);
      await svc.hangup(WS, 'call-1', MANAGER);
      expect(client.hangup).toHaveBeenCalledWith(CREDS, 'u-live-1');
    });

    // ── MEDIUM-1 fix: the REP who ANSWERED a hunt-group/unmatched call ──
    it('allows a REP who is answeredByUserId (not marketingUserId) to hang up a call routed through a hunt group', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(
        liveCall({ marketingUserId: null, answeredByUserId: REP.id }) as any,
      );
      await svc.hangup(WS, 'call-1', REP);
      expect(client.hangup).toHaveBeenCalledWith(CREDS, 'u-live-1');
    });

    it("still 403s an UNRELATED rep even when the call has an answeredByUserId (someone else's)", async () => {
      prisma.salesCall.findFirst.mockResolvedValue(
        liveCall({ marketingUserId: null, answeredByUserId: 'other-rep' }) as any,
      );
      await expect(svc.hangup(WS, 'call-1', REP)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('400s when the call has no live externalCallId yet', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall({ externalCallId: null }) as any);
      await expect(svc.hangup(WS, 'call-1', REP)).rejects.toThrow('Call has no live id yet');
    });

    it('503s when the workspace has no active netsantral config', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
      await expect(svc.hangup(WS, 'call-1', REP)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('hangup', () => {
    it('resolves the live call + creds and calls the client', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      const res = await svc.hangup(WS, 'call-1', REP);
      expect(client.hangup).toHaveBeenCalledWith(CREDS, 'u-live-1');
      expect(res).toEqual({ ok: true });
    });

    it('surfaces the netsantral rejection message as a BadRequestException', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      client.hangup.mockResolvedValue({ ok: false, message: 'Netsantral rejected it' });
      await expect(svc.hangup(WS, 'call-1', REP)).rejects.toThrow('Netsantral rejected it');
    });
  });

  describe('transfer', () => {
    it('blind-transfers to a validated teammate dahili by default', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '105' } as any);
      const res = await svc.transfer(WS, 'call-1', REP, { targetDahili: '105' });
      expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, dahili: '105', status: 'ACTIVE' } }),
      );
      expect(client.blindTransfer).toHaveBeenCalledWith(CREDS, 'u-live-1', '105');
      expect(client.attendedTransfer).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true });
    });

    it('attended-transfers when attended:true', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '106' } as any);
      await svc.transfer(WS, 'call-1', REP, { targetDahili: '106', attended: true });
      expect(client.attendedTransfer).toHaveBeenCalledWith(CREDS, 'u-live-1', '106');
      expect(client.blindTransfer).not.toHaveBeenCalled();
    });

    it('404s when targetDahili is not a teammate extension in this workspace', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      prisma.marketingUser.findFirst.mockResolvedValue(null);
      await expect(svc.transfer(WS, 'call-1', REP, { targetDahili: '999' })).rejects.toBeInstanceOf(NotFoundException);
      expect(client.blindTransfer).not.toHaveBeenCalled();
    });

    it('surfaces a netsantral transfer rejection as BadRequestException', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '105' } as any);
      client.blindTransfer.mockResolvedValue({ ok: false, message: 'busy' });
      await expect(svc.transfer(WS, 'call-1', REP, { targetDahili: '105' })).rejects.toThrow('busy');
    });
  });

  describe('mute', () => {
    it('calls client.mute with on:true', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      const res = await svc.mute(WS, 'call-1', REP, { on: true });
      expect(client.mute).toHaveBeenCalledWith(CREDS, 'u-live-1', true);
      expect(res).toEqual({ ok: true });
    });

    it('calls client.mute with on:false', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      await svc.mute(WS, 'call-1', REP, { on: false });
      expect(client.mute).toHaveBeenCalledWith(CREDS, 'u-live-1', false);
    });

    it('surfaces a netsantral mute rejection as BadRequestException', async () => {
      prisma.salesCall.findFirst.mockResolvedValue(liveCall() as any);
      client.mute.mockResolvedValue({ ok: false, message: 'nope' });
      await expect(svc.mute(WS, 'call-1', REP, { on: true })).rejects.toThrow('nope');
    });
  });
});
