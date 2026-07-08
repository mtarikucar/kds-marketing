import { TelephonyConfigService } from './telephony-config.service';

jest.mock('../../../common/crypto/secret-box.helper', () => ({
  isSecretBoxConfigured: () => true,
  sealSecret: (s: string) => `sealed:${s}`,
  openSecret: (s: string) => s.replace(/^sealed:/, ''),
}));

function prismaMock() {
  return {
    telephonyConfig: { findUnique: jest.fn().mockResolvedValue(undefined), upsert: jest.fn(), update: jest.fn() },
    marketingUser: { findFirst: jest.fn(), updateMany: jest.fn() },
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
});
