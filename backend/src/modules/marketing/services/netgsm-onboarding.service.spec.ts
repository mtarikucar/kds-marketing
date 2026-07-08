import { NetgsmOnboardingService } from './netgsm-onboarding.service';

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV, PUBLIC_BASE_URL: 'https://app.example.com', MARKETING_SECRET_KEY: Buffer.from('a'.repeat(32)).toString('base64') };
});
afterEach(() => {
  process.env = OLD_ENV;
  jest.useRealTimers();
});

function prismaMock() {
  return {
    channel: { findFirst: jest.fn() },
    marketingUser: { count: jest.fn() },
  } as any;
}
function telephonyMock() {
  return { resolveForWorkspace: jest.fn() } as any;
}
function balanceMock() {
  return { fetchBalance: jest.fn() } as any;
}

describe('NetgsmOnboardingService', () => {
  it('smsChannel: missing when no ACTIVE SMS channel exists', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'smsChannel')).toEqual({ key: 'smsChannel', state: 'missing' });
    expect(items.find((i) => i.key === 'moUrl')).toEqual({ key: 'moUrl', state: 'missing' });
  });

  it('smsChannel + moUrl: ok with the minted callback URL when an ACTIVE SMS channel exists', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1' });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'smsChannel')).toEqual({ key: 'smsChannel', state: 'ok' });
    const moUrl = items.find((i) => i.key === 'moUrl');
    expect(moUrl?.state).toBe('ok');
    expect(moUrl?.url).toContain('/api/public/channels/netgsm/chan-1/');
  });

  it('smsCredsLive/santralCredsLive: ok when the shared Netsantral creds probe succeeds', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '850' });
    const balance = balanceMock();
    balance.fetchBalance.mockResolvedValue({ ok: true, credsValid: true, code: null, credit: '10 TL', packages: [], message: null });
    const svc = new NetgsmOnboardingService(prisma, telephony, balance);
    const { items } = await svc.checklist('ws');
    expect(balance.fetchBalance).toHaveBeenCalledWith({ usercode: 'u', password: 'p' });
    const smsCreds = items.find((i) => i.key === 'smsCredsLive');
    const santralCreds = items.find((i) => i.key === 'santralCredsLive');
    expect(smsCreds?.state).toBe('ok');
    expect(santralCreds?.state).toBe('ok');
    // detail names which source was probed (i18n key), not raw prose.
    expect(smsCreds?.detail).toBe('viaSantralCreds');
  });

  it('smsCredsLive: unknown, with a distinct "no source" detail, when there is no TelephonyConfig to probe with', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const balance = balanceMock();
    const svc = new NetgsmOnboardingService(prisma, telephony, balance);
    const { items } = await svc.checklist('ws');
    expect(balance.fetchBalance).not.toHaveBeenCalled();
    const smsCreds = items.find((i) => i.key === 'smsCredsLive');
    expect(smsCreds).toEqual({ key: 'smsCredsLive', state: 'unknown', detail: 'noSantralConfig' });
    expect(items.find((i) => i.key === 'telephonyConfig')).toEqual({ key: 'telephonyConfig', state: 'missing' });
  });

  it('telephonyConfig: ok when resolveForWorkspace returns a config', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(2);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '850' });
    const balance = balanceMock();
    balance.fetchBalance.mockResolvedValue({ ok: true, credsValid: true, code: null, credit: null, packages: [], message: null });
    const svc = new NetgsmOnboardingService(prisma, telephony, balance);
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'telephonyConfig')).toEqual({ key: 'telephonyConfig', state: 'ok' });
  });

  it('repsWithDahili: ok with the count as detail when reps have a dahili', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(2);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock());
    const { items } = await svc.checklist('ws');
    expect(prisma.marketingUser.count).toHaveBeenCalledWith({ where: { workspaceId: 'ws', dahili: { not: null } } });
    expect(items.find((i) => i.key === 'repsWithDahili')).toEqual({ key: 'repsWithDahili', state: 'ok', detail: '2' });
  });

  it('repsWithDahili: missing when no rep has a dahili', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'repsWithDahili')).toEqual({ key: 'repsWithDahili', state: 'missing', detail: '0' });
  });

  it('eventsWebhookUrl: carries the minted per-workspace events URL', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock());
    const { items } = await svc.checklist('ws-1');
    const events = items.find((i) => i.key === 'eventsWebhookUrl');
    expect(events?.state).toBe('unknown');
    expect(events?.url).toContain('/api/public/netgsm/ws-1/');
    expect(events?.url).toContain('/events');
    expect(events?.detail).toBe('eventsWebhookHint');
  });

  it('degrades smsCredsLive/santralCredsLive to unknown when the balance probe does not answer within the timeout (no page hang on a NetGSM outage)', async () => {
    jest.useFakeTimers();
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '850' });
    const balance = balanceMock();
    balance.fetchBalance.mockReturnValue(new Promise(() => {})); // never resolves — simulates a hung NetGSM call
    const svc = new NetgsmOnboardingService(prisma, telephony, balance);

    const pending = svc.checklist('ws');
    await jest.advanceTimersByTimeAsync(6000);
    const { items } = await pending;

    expect(items.find((i) => i.key === 'smsCredsLive')?.state).toBe('unknown');
    expect(items.find((i) => i.key === 'santralCredsLive')?.state).toBe('unknown');
  });
});
