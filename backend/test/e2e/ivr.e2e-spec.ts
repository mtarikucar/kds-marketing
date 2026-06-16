import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac } from 'crypto';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';
import { ChannelAdapterRegistry } from '../../src/modules/marketing/channels/channel-adapter.registry';

/**
 * IVR / phone-tree (e2e, DB seam mocked):
 *  - admin CRUD: OWNER creates a menu + an option (behind the voiceAi feature);
 *    a REP is forbidden;
 *  - the public Twilio webhook serves the IVR <Gather> when a workspace has an
 *    enabled root menu, and FALLS THROUGH to the existing AI flow when it does
 *    not (non-IVR workspaces unaffected). Both require a valid Twilio signature.
 */
describe('IVR phone-tree (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  // The Twilio signature is computed over PUBLIC_BASE_URL + originalUrl, so the
  // webhook path needs a base URL set before the app boots.
  const BASE = 'https://ivr.test.local';
  const AUTH_TOKEN = 'twilio-auth-token';

  beforeAll(async () => {
    process.env.PUBLIC_BASE_URL = BASE;
    // Override the registry's secret decryption so the VOICE channel resolves to
    // a plaintext authToken (avoids needing MARKETING_SECRET_KEY + a real sealed
    // blob just to exercise the Twilio-signature trust boundary).
    ctx = await createTestApp((builder) => {
      builder.overrideProvider(ChannelAdapterRegistry).useValue({
        resolveConfig: () => ({
          channelId: 'ch1', workspaceId: 'ws-1', type: 'VOICE',
          externalId: '+15559999999', secrets: { accountSid: 'AC1', authToken: AUTH_TOKEN }, public: {},
        }),
        register: () => undefined,
        has: () => true,
        get: () => undefined,
        list: () => [],
      });
    });
    app = ctx.app;
  });

  afterAll(async () => {
    delete process.env.PUBLIC_BASE_URL;
    await closeTestApp(app);
  });

  beforeEach(() => jest.clearAllMocks());

  // ── entitlement + auth helpers ───────────────────────────────────────────

  const mockEntitlements = () => {
    ctx.prisma.workspaceSubscription.findUnique.mockResolvedValue({
      id: 'sub-1', workspaceId: 'ws-1', packageId: 'pkg-1', status: 'ACTIVE',
      trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 86400_000),
    } as never);
    ctx.prisma.package.findUnique.mockResolvedValue({
      id: 'pkg-1', code: 'PRO', features: { voiceAi: true },
      dailyLeadQuota: 100, maxUsers: 50, maxResearchProfiles: 10, limits: {},
    } as never);
    ctx.prisma.workspaceAddOn.findMany.mockResolvedValue([] as never);
  };

  const ownerAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'OWNER' }) as never);
    mockEntitlements();
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'OWNER' })}`;
  };

  const repAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'REP' }) as never);
    mockEntitlements();
    return `Bearer ${signMarketingToken({ sub: 'mu-2', wsp: 'ws-1', role: 'REP' })}`;
  };

  // ── admin CRUD ────────────────────────────────────────────────────────────

  it('OWNER creates a root menu', async () => {
    const auth = ownerAuth();
    ctx.prisma.ivrMenu.updateMany.mockResolvedValue({ count: 0 } as never);
    (ctx.prisma.ivrMenu.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'm1', createdAt: new Date(), updatedAt: new Date(), ...data }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/marketing/ivr/menus')
      .set('Authorization', auth)
      .send({ name: 'Main Menu', greeting: 'Welcome to Acme', isRoot: true });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('m1');
    expect(res.body.isRoot).toBe(true);
  });

  it('OWNER adds a DIAL option to a menu', async () => {
    const auth = ownerAuth();
    ctx.prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'm1', workspaceId: 'ws-1' } as never);
    ctx.prisma.ivrOption.findFirst.mockResolvedValue(null as never); // no dupe digit
    (ctx.prisma.ivrOption.create as jest.Mock).mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'o1', createdAt: new Date(), ...data }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/marketing/ivr/menus/m1/options')
      .set('Authorization', auth)
      .send({ digit: '1', label: 'Sales', action: 'DIAL', dialNumber: '+15551234567' });

    expect(res.status).toBe(201);
    expect(res.body.digit).toBe('1');
    expect(res.body.action).toBe('DIAL');
    expect(res.body.dialNumber).toBe('+15551234567');
  });

  it('rejects a DIAL option with a non-E.164 number (400)', async () => {
    const auth = ownerAuth();
    const res = await request(app.getHttpServer())
      .post('/api/marketing/ivr/menus/m1/options')
      .set('Authorization', auth)
      .send({ digit: '1', label: 'Sales', action: 'DIAL', dialNumber: '5551234' });
    expect(res.status).toBe(400);
  });

  it('forbids a REP from creating a menu (403)', async () => {
    const auth = repAuth();
    const res = await request(app.getHttpServer())
      .post('/api/marketing/ivr/menus')
      .set('Authorization', auth)
      .send({ name: 'x', greeting: 'y' });
    expect(res.status).toBe(403);
  });

  // ── public Twilio webhook ──────────────────────────────────────────────────

  const sign = (path: string, body: Record<string, string>) => {
    const url = `${BASE}${path}`;
    const data = url + Object.keys(body).sort().map((k) => k + (body[k] ?? '')).join('');
    return createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
  };

  // The VOICE channel the webhook resolves by To. The registry is overridden
  // (see beforeAll) to hand back the plaintext authToken, so configSealed here
  // is irrelevant — the signature trust boundary is still exercised end to end.
  const voiceChannel = (over: Record<string, unknown> = {}) => ({
    id: 'ch1', workspaceId: 'ws-1', type: 'VOICE', externalId: '+15559999999',
    status: 'ACTIVE', configSealed: null, configPublic: {}, agentProfileId: null,
    ...over,
  });

  it('serves the IVR <Gather> when the workspace has an enabled root menu', async () => {
    ctx.prisma.channel.findFirst.mockResolvedValue(voiceChannel() as never);
    // enabled root menu + its options
    ctx.prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'root-1', workspaceId: 'ws-1', greeting: 'Welcome to Acme', isRoot: true, enabled: true } as never);
    ctx.prisma.ivrOption.findMany.mockResolvedValue([{ digit: '1', label: 'Sales' }] as never);

    const path = '/api/public/channels/twilio/voice';
    const body = { To: '+15559999999', From: '+15551112233', CallSid: 'CA-ivr-1' };
    const res = await request(app.getHttpServer())
      .post(path)
      .type('form')
      .set('x-twilio-signature', sign(path, body))
      .send(body);

    expect(res.status).toBeLessThan(300);
    expect(res.text).toContain('<Gather numDigits="1"');
    expect(res.text).toContain('Welcome to Acme');
    expect(res.text).toContain('For Sales, press 1.');
  });

  it('falls through to the existing AI voice flow when there is NO enabled root menu', async () => {
    ctx.prisma.channel.findFirst.mockResolvedValue(voiceChannel() as never);
    // getEnabledRootMenu → null
    ctx.prisma.ivrMenu.findFirst.mockResolvedValue(null as never);
    // startCall path: upsert the call + greet (no agent profile → default greeting)
    ctx.prisma.voiceCall.upsert.mockResolvedValue({} as never);
    ctx.prisma.voiceTranscript.create.mockResolvedValue({} as never);
    ctx.prisma.lead.findFirst.mockResolvedValue(null as never);
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(ctx.prisma));
    ctx.prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as never);

    const path = '/api/public/channels/twilio/voice';
    const body = { To: '+15559999999', From: '+15551112233', CallSid: 'CA-fallthrough-1' };
    const res = await request(app.getHttpServer())
      .post(path)
      .type('form')
      .set('x-twilio-signature', sign(path, body))
      .send(body);

    expect(res.status).toBeLessThan(300);
    // The AI flow opens the mic with a speech <Gather> (input="speech"), NOT the
    // IVR keypad <Gather numDigits="1">. This proves the fall-through.
    expect(res.text).toContain('input="speech"');
    expect(res.text).not.toContain('numDigits="1"');
    expect(ctx.prisma.voiceCall.upsert).toHaveBeenCalled();
  });

  it('rejects an IVR webhook with a bad Twilio signature (403)', async () => {
    ctx.prisma.channel.findFirst.mockResolvedValue(voiceChannel() as never);
    const path = '/api/public/channels/twilio/voice';
    const body = { To: '+15559999999', From: '+1', CallSid: 'CA-bad' };
    const res = await request(app.getHttpServer())
      .post(path)
      .type('form')
      .set('x-twilio-signature', 'not-a-valid-signature')
      .send(body);
    expect(res.status).toBe(403);
  });
});
