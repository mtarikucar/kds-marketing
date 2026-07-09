import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TelephonyCallbackService } from './telephony-callback.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { TelephonyCallbackDto } from '../dto/telephony-callback.dto';

describe('TelephonyCallbackService', () => {
  let prisma: MockPrismaClient;
  let telephonyConfig: { resolveForWorkspace: jest.Mock };
  let registry: { resolveConfig: jest.Mock };
  let client: { dynamicRedirect: jest.Mock };
  let iysClient: { search: jest.Mock };
  let svc: TelephonyCallbackService;

  const WS = 'ws-1';
  const NETSANTRAL_CREDS = { username: '8508407303', password: 'pbx-pw', trunk: '8508407303' };
  const SMS_CHANNEL = { id: 'chan-sms-1', workspaceId: WS, type: 'SMS', status: 'ACTIVE' };
  const DTO: TelephonyCallbackDto = { phone: '0532 111 22 33', redirectType: 'queue', redirectMenu: '850-queue-vip' };

  beforeEach(() => {
    prisma = mockPrismaClient();
    telephonyConfig = { resolveForWorkspace: jest.fn().mockResolvedValue(NETSANTRAL_CREDS) };
    registry = {
      resolveConfig: jest.fn().mockReturnValue({
        secrets: { usercode: 'sms-user', password: 'sms-pw' },
        public: { brandCode: 'BRAND1' },
      }),
    };
    client = { dynamicRedirect: jest.fn().mockResolvedValue({ ok: true, callId: 'cb-1' }) };
    iysClient = { search: jest.fn().mockResolvedValue({ ok: true, status: 'ONAY', message: null }) };
    prisma.channel.findFirst.mockResolvedValue(SMS_CHANNEL as any);
    svc = new TelephonyCallbackService(prisma as any, telephonyConfig as any, registry as any, client as any, iysClient as any);
  });

  it('happy path: resolves creds, checks İYS ARAMA ONAY, calls dynamicRedirect with iysfilter=11 + brandcode', async () => {
    const res = await svc.requestCallback(WS, DTO);

    expect(res).toEqual({ ok: true });
    expect(telephonyConfig.resolveForWorkspace).toHaveBeenCalledWith(WS);
    expect(iysClient.search).toHaveBeenCalledWith(
      { usercode: 'sms-user', password: 'sms-pw', brandCode: 'BRAND1' },
      '905321112233',
      'ARAMA',
    );
    expect(client.dynamicRedirect).toHaveBeenCalledWith(NETSANTRAL_CREDS, {
      phone: '905321112233',
      redirectMenu: '850-queue-vip',
      redirectType: 'queue',
      iysfilter: '11',
      brandcode: 'BRAND1',
    });
  });

  it('refuses (503) when Netsantral is not configured for the workspace', async () => {
    telephonyConfig.resolveForWorkspace.mockResolvedValue(null);
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.dynamicRedirect).not.toHaveBeenCalled();
  });

  it('refuses (503) when there is no ACTIVE SMS channel to resolve İYS creds from', async () => {
    prisma.channel.findFirst.mockResolvedValue(null);
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(iysClient.search).not.toHaveBeenCalled();
    expect(client.dynamicRedirect).not.toHaveBeenCalled();
  });

  it('refuses (400) — İYS filter mandatory — when no brandCode is configured', async () => {
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'sms-user', password: 'sms-pw' }, public: {} });
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(BadRequestException);
    expect(iysClient.search).not.toHaveBeenCalled();
    expect(client.dynamicRedirect).not.toHaveBeenCalled();
  });

  it('refuses (400) an invalid/non-mobile phone number before ever calling İYS', async () => {
    await expect(svc.requestCallback(WS, { ...DTO, phone: '123' })).rejects.toBeInstanceOf(BadRequestException);
    expect(iysClient.search).not.toHaveBeenCalled();
  });

  it('fail-closed (503) when İYS is unreachable/unclassifiable', async () => {
    iysClient.search.mockResolvedValue({ ok: false, status: null, message: 'boom' });
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.dynamicRedirect).not.toHaveBeenCalled();
  });

  it('refuses (400) when İYS reports RET (no arama consent)', async () => {
    iysClient.search.mockResolvedValue({ ok: true, status: 'RET', message: null });
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.dynamicRedirect).not.toHaveBeenCalled();
  });

  it('refuses (400) when İYS reports YOK (no consent record at all)', async () => {
    iysClient.search.mockResolvedValue({ ok: true, status: 'YOK', message: null });
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.dynamicRedirect).not.toHaveBeenCalled();
  });

  it('surfaces a BadRequestException when Netsantral rejects the dynamicRedirect call', async () => {
    client.dynamicRedirect.mockResolvedValue({ ok: false, message: 'Netsantral rejected it' });
    await expect(svc.requestCallback(WS, DTO)).rejects.toBeInstanceOf(BadRequestException);
  });
});
