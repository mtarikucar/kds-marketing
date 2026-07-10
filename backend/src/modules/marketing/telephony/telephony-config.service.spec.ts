import { TelephonyConfigService } from './telephony-config.service';

jest.mock('../../../common/crypto/secret-box.helper', () => ({
  isSecretBoxConfigured: () => true,
  sealSecret: (s: string) => `sealed:${s}`,
  openSecret: (s: string) => s.replace(/^sealed:/, ''),
}));

function prismaMock() {
  return {
    telephonyConfig: { findUnique: jest.fn().mockResolvedValue(undefined), upsert: jest.fn(), update: jest.fn() },
    marketingUser: { findFirst: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  } as any;
}

function balanceClientMock() {
  return { fetchBalance: jest.fn() } as any;
}

describe('TelephonyConfigService', () => {
  it('seals secrets on upsert and masks them on read', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.upsert.mockResolvedValue({
      id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
      configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '850', pbxnum: null,
    });
    const svc = new TelephonyConfigService(prisma, balanceClientMock());
    const out = await svc.upsert('ws', { secrets: { username: '850', password: 'pw' }, trunk: '8508407303' });
    expect(prisma.telephonyConfig.upsert).toHaveBeenCalled();
    expect(out.configuredSecrets.sort()).toEqual(['password', 'username']);
    expect((out as any).configSealed).toBeUndefined();
  });

  it('resolveForWorkspace returns decrypted creds for an ACTIVE config', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue({
      workspaceId: 'ws', status: 'ACTIVE', trunk: '850', pbxnum: null,
      configSealed: 'sealed:{"username":"850","password":"pw"}',
    });
    const svc = new TelephonyConfigService(prisma, balanceClientMock());
    const r = await svc.resolveForWorkspace('ws');
    expect(r).toEqual({ username: '850', password: 'pw', trunk: '850', pbxnum: undefined });
  });

  it('resolveForWorkspace returns recordCalls from the config row (NetGSM Phase 4 Task 1)', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue({
      workspaceId: 'ws', status: 'ACTIVE', trunk: '850', pbxnum: null, recordCalls: true,
      configSealed: 'sealed:{"username":"850","password":"pw"}',
    });
    const svc = new TelephonyConfigService(prisma, balanceClientMock());
    const r = await svc.resolveForWorkspace('ws');
    expect(r).toEqual({ username: '850', password: 'pw', trunk: '850', pbxnum: undefined, recordCalls: true });
  });

  it('resolveForWorkspace returns null when no config or DISABLED', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue(null);
    expect(await new TelephonyConfigService(prisma, balanceClientMock()).resolveForWorkspace('ws')).toBeNull();
  });

  it('setDahili scopes to the workspace and throws when no row matched', async () => {
    const prisma = prismaMock();
    prisma.marketingUser.updateMany.mockResolvedValue({ count: 0 });
    await expect(new TelephonyConfigService(prisma, balanceClientMock()).setDahili('ws', 'u', '104')).rejects.toThrow(/not found/i);
  });

  it('upsert stores wssUrl + sipDomain', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.upsert.mockResolvedValue({ id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE', configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null, wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com' });
    const svc = new TelephonyConfigService(prisma, balanceClientMock());
    const out = await svc.upsert('ws', { secrets: { username: '850', password: 'pw' }, trunk: '8508407303', wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com' });
    expect((out as any).wssUrl).toBe('wss://sip5.netsantral.com:8089/ws');
    const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
    expect(data.wssUrl).toBe('wss://sip5.netsantral.com:8089/ws');
    expect(data.sipDomain).toBe('sip5.netsantral.com');
  });

  describe('call-recording config (NetGSM Phase 4 Task 1)', () => {
    it('upsert persists recordCalls + recordingRetentionDays', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        recordCalls: true, recordingRetentionDays: 30,
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      const out = await svc.upsert('ws', {
        secrets: { username: '850', password: 'pw' }, trunk: '8508407303',
        recordCalls: true, recordingRetentionDays: 30,
      });
      expect((out as any).recordCalls).toBe(true);
      expect((out as any).recordingRetentionDays).toBe(30);
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(data.recordCalls).toBe(true);
      expect(data.recordingRetentionDays).toBe(30);
    });

    it('upsert defaults recordCalls to false and retention to null for a brand-new config', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        recordCalls: false, recordingRetentionDays: null,
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      await svc.upsert('ws', { secrets: { username: '850', password: 'pw' }, trunk: '8508407303' });
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(data.recordCalls).toBe(false);
      expect(data.recordingRetentionDays).toBeNull();
    });

    it('upsert keeps the existing recordCalls/retention when the caller omits both fields', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', status: 'ACTIVE', trunk: '8508407303', pbxnum: null,
        configSealed: 'sealed:{"username":"850","password":"pw"}',
        recordCalls: true, recordingRetentionDays: 14,
      });
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        recordCalls: true, recordingRetentionDays: 14,
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      await svc.upsert('ws', { trunk: '8508407303' }); // no recordCalls/recordingRetentionDays sent
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(data.recordCalls).toBe(true);
      expect(data.recordingRetentionDays).toBe(14);
    });

    it('upsert explicitly clears recordingRetentionDays back to null ("keep forever") when the caller sends null', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', status: 'ACTIVE', trunk: '8508407303', pbxnum: null,
        configSealed: 'sealed:{"username":"850","password":"pw"}',
        recordCalls: true, recordingRetentionDays: 14,
      });
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        recordCalls: true, recordingRetentionDays: null,
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      await svc.upsert('ws', { trunk: '8508407303', recordingRetentionDays: null });
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(data.recordingRetentionDays).toBeNull();
    });
  });

  it('setDahili seals the SIP password', async () => {
    const prisma = prismaMock();
    prisma.marketingUser.updateMany.mockResolvedValue({ count: 1 });
    await new TelephonyConfigService(prisma, balanceClientMock()).setDahili('ws', 'u', '101', 'sip-pw');
    const data = prisma.marketingUser.updateMany.mock.calls[0][0].data;
    expect(data.dahili).toBe('101');
    expect(data.dahiliSecret).toBe('sealed:sip-pw');
  });

  it('webphoneConfigFor returns the rep webphone config when complete', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue({ workspaceId: 'ws', status: 'ACTIVE', wssUrl: 'wss://x/ws', sipDomain: 'sip5.netsantral.com', trunk: '850', configSealed: 'sealed:{"username":"850","password":"pw"}' });
    prisma.marketingUser.findFirst.mockResolvedValue({ dahili: '101', dahiliSecret: 'sealed:sip-pw', firstName: 'A', lastName: 'B' });
    const r = await new TelephonyConfigService(prisma, balanceClientMock()).webphoneConfigFor('ws', 'u');
    // SIP auth username is the FULL "<ext>-<trunk>" (NetGSM requirement) — derived
    // from the rep's bare extension (101) + the config trunk (850).
    expect(r).toEqual({ wssUrl: 'wss://x/ws', sipDomain: 'sip5.netsantral.com', dahili: '101-850', sipPassword: 'sip-pw', displayName: 'A B' });
    // the rep lookup MUST be scoped to {id, workspaceId} — no cross-tenant/user read
    expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith({
      where: { id: 'u', workspaceId: 'ws' },
      select: { dahili: true, dahiliSecret: true, firstName: true, lastName: true },
    });
  });

  it('webphoneConfigFor returns null when the rep has no dahili/secret', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue({ workspaceId: 'ws', status: 'ACTIVE', wssUrl: 'wss://x/ws', sipDomain: 'd', trunk: '850', configSealed: 'sealed:{}' });
    prisma.marketingUser.findFirst.mockResolvedValue({ dahili: null, dahiliSecret: null, firstName: 'A', lastName: 'B' });
    expect(await new TelephonyConfigService(prisma, balanceClientMock()).webphoneConfigFor('ws', 'u')).toBeNull();
  });

  describe('verifyCreds', () => {
    it('returns configured:false without probing when there is no ACTIVE config', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue(null);
      const balance = balanceClientMock();
      const r = await new TelephonyConfigService(prisma, balance).verifyCreds('ws');
      expect(r).toEqual({ configured: false, balance: null });
      expect(balance.fetchBalance).not.toHaveBeenCalled();
    });

    it('probes /balance with the resolved creds for an ACTIVE config', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', status: 'ACTIVE', trunk: '850', pbxnum: null,
        configSealed: 'sealed:{"username":"850","password":"pw"}',
      });
      const balance = balanceClientMock();
      const balanceResult = { ok: true, credsValid: true, code: null, credit: '12.34', packages: [], message: null };
      balance.fetchBalance.mockResolvedValue(balanceResult);
      const r = await new TelephonyConfigService(prisma, balance).verifyCreds('ws');
      expect(balance.fetchBalance).toHaveBeenCalledWith({ usercode: '850', password: 'pw' });
      expect(r).toEqual({ configured: true, balance: balanceResult });
    });
  });

  describe('Netasistan config (NetGSM Phase 6 Task 4)', () => {
    it('upsert seals appKey/userKey into netasistanConfigSealed, independent of configSealed', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        netasistanConfigSealed: 'sealed:{"appKey":"ak","userKey":"uk"}',
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      const out = await svc.upsert('ws', {
        secrets: { username: '850', password: 'pw' }, trunk: '8508407303',
        netasistan: { appKey: 'ak', userKey: 'uk' },
      });
      expect((out as any).netasistanConfigured).toBe(true);
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(data.netasistanConfigSealed).toBe('sealed:{"appKey":"ak","userKey":"uk"}');
    });

    it('upsert merges a partial Netasistan update onto the existing sealed keys', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', status: 'ACTIVE', trunk: '8508407303', pbxnum: null,
        configSealed: 'sealed:{"username":"850","password":"pw"}',
        netasistanConfigSealed: 'sealed:{"appKey":"old-ak","userKey":"old-uk"}',
      });
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        netasistanConfigSealed: 'sealed:{"appKey":"old-ak","userKey":"new-uk"}',
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      await svc.upsert('ws', { trunk: '8508407303', netasistan: { userKey: 'new-uk' } });
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(JSON.parse(data.netasistanConfigSealed.replace(/^sealed:/, ''))).toEqual({
        appKey: 'old-ak', userKey: 'new-uk',
      });
    });

    it('upsert leaves netasistanConfigSealed untouched when no netasistan field is sent', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', status: 'ACTIVE', trunk: '8508407303', pbxnum: null,
        configSealed: 'sealed:{"username":"850","password":"pw"}',
        netasistanConfigSealed: 'sealed:{"appKey":"ak","userKey":"uk"}',
      });
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        netasistanConfigSealed: 'sealed:{"appKey":"ak","userKey":"uk"}',
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      await svc.upsert('ws', { trunk: '8508407303' });
      const data = prisma.telephonyConfig.upsert.mock.calls[0][0].update;
      expect(data.netasistanConfigSealed).toBe('sealed:{"appKey":"ak","userKey":"uk"}');
    });

    it('mask() reports netasistanConfigured:false when unset', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.upsert.mockResolvedValue({
        id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
        configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '8508407303', pbxnum: null,
        netasistanConfigSealed: null,
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      const out = await svc.upsert('ws', { secrets: { username: '850', password: 'pw' }, trunk: '8508407303' });
      expect((out as any).netasistanConfigured).toBe(false);
    });

    it('resolveNetasistanForWorkspace returns decrypted {appKey,userKey} when configured', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', netasistanConfigSealed: 'sealed:{"appKey":"ak","userKey":"uk"}',
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      expect(await svc.resolveNetasistanForWorkspace('ws')).toEqual({ appKey: 'ak', userKey: 'uk' });
    });

    it('resolveNetasistanForWorkspace returns null when nothing is configured', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({ workspaceId: 'ws', netasistanConfigSealed: null });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      expect(await svc.resolveNetasistanForWorkspace('ws')).toBeNull();
    });

    it('resolveNetasistanForWorkspace returns null when the config row does not exist at all', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue(null);
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      expect(await svc.resolveNetasistanForWorkspace('ws')).toBeNull();
    });

    it('resolveNetasistanForWorkspace does NOT require the santral status to be ACTIVE', async () => {
      const prisma = prismaMock();
      prisma.telephonyConfig.findUnique.mockResolvedValue({
        workspaceId: 'ws', status: 'DISABLED', netasistanConfigSealed: 'sealed:{"appKey":"ak","userKey":"uk"}',
      });
      const svc = new TelephonyConfigService(prisma, balanceClientMock());
      expect(await svc.resolveNetasistanForWorkspace('ws')).toEqual({ appKey: 'ak', userKey: 'uk' });
    });

    it('setDahili persists netasistanOptIn when explicitly provided', async () => {
      const prisma = prismaMock();
      prisma.marketingUser.updateMany.mockResolvedValue({ count: 1 });
      await new TelephonyConfigService(prisma, balanceClientMock()).setDahili('ws', 'u', undefined, undefined, undefined, true);
      const data = prisma.marketingUser.updateMany.mock.calls[0][0].data;
      expect(data.netasistanOptIn).toBe(true);
    });

    it('setDahili leaves netasistanOptIn untouched when omitted (undefined)', async () => {
      const prisma = prismaMock();
      prisma.marketingUser.updateMany.mockResolvedValue({ count: 1 });
      await new TelephonyConfigService(prisma, balanceClientMock()).setDahili('ws', 'u', '104');
      const data = prisma.marketingUser.updateMany.mock.calls[0][0].data;
      expect('netasistanOptIn' in data).toBe(false);
    });
  });

  describe('listTeammateDahilis (Phase 3 Task 5 transfer picker)', () => {
    it('lists ACTIVE users with a dahili, excluding the caller', async () => {
      const prisma = prismaMock();
      const rows = [{ id: 'rep-2', firstName: 'B', lastName: 'C', dahili: '105' }];
      prisma.marketingUser.findMany.mockResolvedValue(rows);
      const r = await new TelephonyConfigService(prisma, balanceClientMock()).listTeammateDahilis('ws', 'rep-1');
      expect(prisma.marketingUser.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws', status: 'ACTIVE', dahili: { not: null }, id: { not: 'rep-1' } },
        select: { id: true, firstName: true, lastName: true, dahili: true },
        orderBy: { firstName: 'asc' },
      });
      expect(r).toEqual(rows);
    });
  });
});
