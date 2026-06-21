import { TelephonyConfigService } from './telephony-config.service';

jest.mock('../../../common/crypto/secret-box.helper', () => ({
  isSecretBoxConfigured: () => true,
  sealSecret: (s: string) => `sealed:${s}`,
  openSecret: (s: string) => s.replace(/^sealed:/, ''),
}));

function prismaMock() {
  return {
    telephonyConfig: { findUnique: jest.fn().mockResolvedValue(undefined), upsert: jest.fn(), update: jest.fn() },
    marketingUser: { updateMany: jest.fn() },
  } as any;
}

describe('TelephonyConfigService', () => {
  it('seals secrets on upsert and masks them on read', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.upsert.mockResolvedValue({
      id: 'c1', workspaceId: 'ws', provider: 'netgsm-netsantral', status: 'ACTIVE',
      configSealed: 'sealed:{"username":"850","password":"pw"}', trunk: '850', pbxnum: null,
    });
    const svc = new TelephonyConfigService(prisma);
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
    const svc = new TelephonyConfigService(prisma);
    const r = await svc.resolveForWorkspace('ws');
    expect(r).toEqual({ username: '850', password: 'pw', trunk: '850', pbxnum: undefined });
  });

  it('resolveForWorkspace returns null when no config or DISABLED', async () => {
    const prisma = prismaMock();
    prisma.telephonyConfig.findUnique.mockResolvedValue(null);
    expect(await new TelephonyConfigService(prisma).resolveForWorkspace('ws')).toBeNull();
  });

  it('setDahili scopes to the workspace and throws when no row matched', async () => {
    const prisma = prismaMock();
    prisma.marketingUser.updateMany.mockResolvedValue({ count: 0 });
    await expect(new TelephonyConfigService(prisma).setDahili('ws', 'u', '104')).rejects.toThrow(/not found/i);
  });
});
