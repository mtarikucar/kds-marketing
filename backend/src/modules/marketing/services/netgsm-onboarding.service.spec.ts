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
    // NetGSM Phase 2 Task 6 — iysFirstSync's live check. Default: no job
    // found (mirrors a workspace with no consent changes yet).
    iysSyncJob: { findFirst: jest.fn().mockResolvedValue(null) },
    // NetGSM Phase 3 Task 7 — eventsWebhookReceiving's live check. Default:
    // no recent events (mirrors a workspace that hasn't registered/tested
    // the events webhook yet).
    netgsmWebhookEvent: { count: jest.fn().mockResolvedValue(0) },
    // NetGSM Phase 4 Task 7 — recordingsReceiving's live check. Default: no
    // recently-recorded call (mirrors a workspace that hasn't recorded yet).
    salesCall: { count: jest.fn().mockResolvedValue(0) },
  } as any;
}
function telephonyMock() {
  return { resolveForWorkspace: jest.fn() } as any;
}
function balanceMock() {
  return { fetchBalance: jest.fn() } as any;
}
function smsV2Mock() {
  return { msgheaders: jest.fn() } as any;
}
/** Default: no sealed secrets (mirrors an unconfigured/absent channel) — the
 *  senderHeaders-specific tests override resolveConfig's return value. */
function registryMock() {
  return { resolveConfig: jest.fn().mockReturnValue({ secrets: {}, public: {} }) } as any;
}
/** Default: not configured (mirrors an env without R2_* vars set) — the
 *  recordingStorage-specific tests override isConfigured's return value. */
function r2Mock() {
  return { isConfigured: jest.fn().mockReturnValue(false) } as any;
}

describe('NetgsmOnboardingService', () => {
  it('smsChannel: missing when no ACTIVE SMS channel exists', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
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
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
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
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2Mock());
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
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2Mock());
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
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'telephonyConfig')).toEqual({ key: 'telephonyConfig', state: 'ok' });
  });

  it('repsWithDahili: ok with the count as detail when reps have a dahili', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(2);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
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
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'repsWithDahili')).toEqual({ key: 'repsWithDahili', state: 'missing', detail: '0' });
  });

  it('eventsWebhookUrl: carries the minted per-workspace events URL', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    const events = items.find((i) => i.key === 'eventsWebhookUrl');
    expect(events?.state).toBe('unknown');
    expect(events?.url).toContain('/api/public/netgsm/ws-1/');
    expect(events?.url).toContain('/events');
    expect(events?.detail).toBe('eventsWebhookHint');
  });

  it('eventsWebhookReceiving: unknown with the register+test hint when no events-purpose webhook has landed in the last 7 days', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    prisma.netgsmWebhookEvent.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(prisma.netgsmWebhookEvent.count).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        purpose: 'events',
        receivedAt: { gte: expect.any(Date) },
      },
    });
    expect(items.find((i) => i.key === 'eventsWebhookReceiving')).toEqual({
      key: 'eventsWebhookReceiving', state: 'unknown', detail: 'eventsWebhookReceivingHint',
    });
  });

  it('eventsWebhookReceiving: ok (no detail) once at least one events-purpose webhook has landed in the last 7 days', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    prisma.netgsmWebhookEvent.count.mockResolvedValue(3);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'eventsWebhookReceiving')).toEqual({
      key: 'eventsWebhookReceiving', state: 'ok', detail: undefined,
    });
  });

  it('iysWebhook: missing (with the minted per-workspace İYS URL) when no ACTIVE SMS channel exists', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    const iysWebhook = items.find((i) => i.key === 'iysWebhook');
    expect(iysWebhook?.state).toBe('missing');
    expect(iysWebhook?.url).toContain('/api/public/netgsm/ws-1/');
    expect(iysWebhook?.url).toContain('/iys');
  });

  it('iysWebhook: missing when the ACTIVE SMS channel exists but has not registered yet', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1', configPublic: {} });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'iysWebhook')?.state).toBe('missing');
  });

  it('iysWebhook: ok once configPublic.iysWebhookRegistered is stamped true by a successful registration', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1', configPublic: { iysWebhookRegistered: true } });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'iysWebhook')?.state).toBe('ok');
  });

  it('iysBrandCode: missing when no ACTIVE SMS channel exists', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'iysBrandCode')).toEqual({ key: 'iysBrandCode', state: 'missing' });
  });

  it('iysBrandCode: missing when the ACTIVE SMS channel exists but configPublic.brandCode is blank/absent', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1', configPublic: { brandCode: '   ' } });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'iysBrandCode')?.state).toBe('missing');
  });

  it('iysBrandCode: ok once configPublic.brandCode is set on the ACTIVE SMS channel', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1', configPublic: { brandCode: 'BRAND1' } });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'iysBrandCode')).toEqual({ key: 'iysBrandCode', state: 'ok' });
  });

  it('iysFirstSync: unknown when no CONFIRMED/SENT IysSyncJob exists for the workspace (not necessarily broken — may just be no consent changes yet)', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(prisma.iysSyncJob.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', status: { in: ['CONFIRMED', 'SENT'] } },
      select: { id: true },
    });
    expect(items.find((i) => i.key === 'iysFirstSync')).toEqual({ key: 'iysFirstSync', state: 'unknown' });
  });

  it('iysFirstSync: ok once at least one IysSyncJob has reached SENT or CONFIRMED', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    prisma.iysSyncJob.findFirst.mockResolvedValue({ id: 'job-1' });
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'iysFirstSync')).toEqual({ key: 'iysFirstSync', state: 'ok' });
  });

  it('otpPackage: always unknown with the error-60 explainer detail (no live probe — sending a real OTP would be a wasted, user-facing send)', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'otpPackage')).toEqual({
      key: 'otpPackage', state: 'unknown', detail: 'otpPackageHint',
    });
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
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2Mock());

    const pending = svc.checklist('ws');
    await jest.advanceTimersByTimeAsync(6000);
    const { items } = await pending;

    expect(items.find((i) => i.key === 'smsCredsLive')?.state).toBe('unknown');
    expect(items.find((i) => i.key === 'santralCredsLive')?.state).toBe('unknown');
  });

  it('senderHeaders: unknown when no ACTIVE SMS channel exists (nothing to probe)', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const smsV2 = smsV2Mock();
    const registry = registryMock();
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2, registry, r2Mock());
    const { items } = await svc.checklist('ws');
    expect(registry.resolveConfig).not.toHaveBeenCalled();
    expect(smsV2.msgheaders).not.toHaveBeenCalled();
    expect(items.find((i) => i.key === 'senderHeaders')).toEqual({
      key: 'senderHeaders', state: 'unknown', detail: 'headersUnavailable',
    });
  });

  it('senderHeaders: unknown when the channel exists but has no sealed usercode/password/msgheader yet', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1' });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const smsV2 = smsV2Mock();
    const registry = registryMock(); // default: secrets: {}
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2, registry, r2Mock());
    const { items } = await svc.checklist('ws');
    expect(smsV2.msgheaders).not.toHaveBeenCalled();
    expect(items.find((i) => i.key === 'senderHeaders')).toEqual({
      key: 'senderHeaders', state: 'unknown', detail: 'headersUnavailable',
    });
  });

  it('senderHeaders: unknown when the msgheader-list endpoint is unavailable (creds live otherwise)', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1' });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const smsV2 = smsV2Mock();
    smsV2.msgheaders.mockResolvedValue({ ok: false, headers: [] });
    const registry = registryMock();
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u', password: 'p', msgheader: 'BRAND' }, public: {} });
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2, registry, r2Mock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'senderHeaders')).toEqual({
      key: 'senderHeaders', state: 'unknown', detail: 'headersUnavailable',
    });
  });

  it('senderHeaders: ok with the approved-list count as detail when the configured msgheader is in the account\'s approved list', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1' });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const smsV2 = smsV2Mock();
    smsV2.msgheaders.mockResolvedValue({ ok: true, headers: ['BRAND', 'OTHERHDR', 'THIRDHDR'] });
    const registry = registryMock();
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u', password: 'p', msgheader: 'BRAND' }, public: {} });
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2, registry, r2Mock());
    const { items } = await svc.checklist('ws');
    expect(smsV2.msgheaders).toHaveBeenCalledWith({ usercode: 'u', password: 'p' });
    expect(items.find((i) => i.key === 'senderHeaders')).toEqual({
      key: 'senderHeaders', state: 'ok', detail: '3',
    });
  });

  it('senderHeaders: missing, naming the configured header, when it is NOT in the account\'s approved list', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue({ id: 'chan-1' });
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const smsV2 = smsV2Mock();
    smsV2.msgheaders.mockResolvedValue({ ok: true, headers: ['OTHERHDR'] });
    const registry = registryMock();
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u', password: 'p', msgheader: 'BRAND' }, public: {} });
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2, registry, r2Mock());
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'senderHeaders')).toEqual({
      key: 'senderHeaders', state: 'missing', detail: 'BRAND',
    });
  });

  it('recordingStorage: unknown (KVKK hint) when recordCalls is off — nothing to check', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '850', recordCalls: false });
    const balance = balanceMock();
    balance.fetchBalance.mockResolvedValue({ ok: true, credsValid: true, code: null, credit: null, packages: [], message: null });
    const r2 = r2Mock();
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2);
    const { items } = await svc.checklist('ws');
    expect(r2.isConfigured).not.toHaveBeenCalled();
    expect(items.find((i) => i.key === 'recordingStorage')).toEqual({
      key: 'recordingStorage', state: 'unknown', detail: 'recordingStorageKvkkHint',
    });
  });

  it('recordingStorage: unknown when there is no TelephonyConfig at all (recordCalls treated as off)', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const r2 = r2Mock();
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2);
    const { items } = await svc.checklist('ws');
    expect(r2.isConfigured).not.toHaveBeenCalled();
    expect(items.find((i) => i.key === 'recordingStorage')).toEqual({
      key: 'recordingStorage', state: 'unknown', detail: 'recordingStorageKvkkHint',
    });
  });

  it('recordingStorage: missing when recordCalls is on but R2 is not configured', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '850', recordCalls: true });
    const balance = balanceMock();
    balance.fetchBalance.mockResolvedValue({ ok: true, credsValid: true, code: null, credit: null, packages: [], message: null });
    const r2 = r2Mock();
    r2.isConfigured.mockReturnValue(false);
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2);
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'recordingStorage')).toEqual({
      key: 'recordingStorage', state: 'missing', detail: 'recordingStorageKvkkHint',
    });
  });

  it('recordingStorage: ok when recordCalls is on AND R2 is configured', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue({ username: 'u', password: 'p', trunk: '850', recordCalls: true });
    const balance = balanceMock();
    balance.fetchBalance.mockResolvedValue({ ok: true, credsValid: true, code: null, credit: null, packages: [], message: null });
    const r2 = r2Mock();
    r2.isConfigured.mockReturnValue(true);
    const svc = new NetgsmOnboardingService(prisma, telephony, balance, smsV2Mock(), registryMock(), r2);
    const { items } = await svc.checklist('ws');
    expect(items.find((i) => i.key === 'recordingStorage')).toEqual({
      key: 'recordingStorage', state: 'ok', detail: 'recordingStorageKvkkHint',
    });
  });

  it('recordingsReceiving: unknown with the record-a-call hint when no SalesCall has a recordingStorageKey in the last 7 days', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    prisma.salesCall.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(prisma.salesCall.count).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        recordingStorageKey: { not: null },
        endedAt: { gte: expect.any(Date) },
      },
    });
    expect(items.find((i) => i.key === 'recordingsReceiving')).toEqual({
      key: 'recordingsReceiving', state: 'unknown', detail: 'recordingsReceivingHint',
    });
  });

  it('recordingsReceiving: ok (no detail) once at least one SalesCall has a recordingStorageKey in the last 7 days', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    prisma.salesCall.count.mockResolvedValue(4);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    expect(items.find((i) => i.key === 'recordingsReceiving')).toEqual({
      key: 'recordingsReceiving', state: 'ok', detail: undefined,
    });
  });

  it('voiceReportWebhook: always unknown (no provisioning read-back), carrying the minted per-workspace voice-report URL', async () => {
    const prisma = prismaMock();
    prisma.channel.findFirst.mockResolvedValue(null);
    prisma.marketingUser.count.mockResolvedValue(0);
    const telephony = telephonyMock();
    telephony.resolveForWorkspace.mockResolvedValue(null);
    const svc = new NetgsmOnboardingService(prisma, telephony, balanceMock(), smsV2Mock(), registryMock(), r2Mock());
    const { items } = await svc.checklist('ws-1');
    const row = items.find((i) => i.key === 'voiceReportWebhook');
    expect(row?.state).toBe('unknown');
    expect(row?.url).toContain('/api/public/netgsm/ws-1/');
    expect(row?.url).toContain('/voice-report');
    expect(row?.detail).toBe('voiceReportWebhookHint');
  });
});
