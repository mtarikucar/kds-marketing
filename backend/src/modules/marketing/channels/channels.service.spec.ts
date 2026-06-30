import { ChannelsService } from './channels.service';
import * as secretBox from '../../../common/crypto/secret-box.helper';

/**
 * Focused tests for ChannelsService.mask() — the public view of a channel.
 * mask() is private, so we drive it through list() with a stubbed Prisma.
 */
describe('ChannelsService — mask()', () => {
  const PUBLIC_BASE_URL = 'https://app.example.com';

  function makeService(channelRow: any): ChannelsService {
    const prisma = { channel: { findMany: jest.fn().mockResolvedValue([channelRow]) } } as any;
    const registry = {} as any;
    const resolver = {} as any;
    return new ChannelsService(prisma, registry, resolver);
  }

  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    // A 32-byte base64 key so netgsmMoCallbackUrl can mint tokens without throwing
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32).toString('base64');
    // Make secret-box helpers safe for tests that don't set up keys
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.MARKETING_SECRET_KEY;
    jest.restoreAllMocks();
  });

  it('SMS channel: mask exposes callbackUrl and no webhookUrl/messaging', async () => {
    const svc = makeService({
      id: 'ch-sms',
      type: 'SMS',
      name: 'SMS line',
      status: 'ACTIVE',
      agentProfileId: null,
      widgetKey: null,
      externalId: null,
      configPublic: null,
      configSealed: null,
      lastVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [result] = await svc.list('ws-1');
    expect(result.callbackUrl).toContain('/api/public/channels/netgsm/');
    expect(result).not.toHaveProperty('webhookUrl');
    expect(result).not.toHaveProperty('messaging');
  });

  it('TIKTOK channel: mask exposes webhookUrl + messaging, never the token', async () => {
    const svc = makeService({
      id: 'ch-tiktok',
      type: 'TIKTOK',
      name: 'TikTok DM',
      status: 'ACTIVE',
      agentProfileId: null,
      widgetKey: null,
      externalId: 'biz123',
      configPublic: { messaging: true },
      configSealed: null, // no sealed secrets — configuredSecrets will be []
      lastVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [result] = await svc.list('ws-1');
    expect(result.webhookUrl).toBe(`${PUBLIC_BASE_URL}/api/public/channels/tiktok/webhook`);
    expect(result.messaging).toBe(true);
    // Token must NOT be present in any field
    expect(result).not.toHaveProperty('accessToken');
    expect(result.configuredSecrets).toEqual([]);
    // SMS-specific field must not leak onto TIKTOK
    expect(result).not.toHaveProperty('callbackUrl');
  });

  it('TIKTOK channel: messaging null when not set in configPublic', async () => {
    const svc = makeService({
      id: 'ch-tiktok-2',
      type: 'TIKTOK',
      name: 'TikTok DM bare',
      status: 'ACTIVE',
      agentProfileId: null,
      widgetKey: null,
      externalId: null,
      configPublic: null,
      configSealed: null,
      lastVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [result] = await svc.list('ws-1');
    expect(result.messaging).toBeNull();
    expect(result.webhookUrl).toBe(`${PUBLIC_BASE_URL}/api/public/channels/tiktok/webhook`);
  });

  it('TIKTOK channel: webhookUrl is null when PUBLIC_BASE_URL is unset', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const svc = makeService({
      id: 'ch-tiktok-3',
      type: 'TIKTOK',
      name: 'TikTok DM no base',
      status: 'ACTIVE',
      agentProfileId: null,
      widgetKey: null,
      externalId: null,
      configPublic: null,
      configSealed: null,
      lastVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [result] = await svc.list('ws-1');
    expect(result.webhookUrl).toBeNull();
  });

  it('Meta channel: exposes webhookUrl + verifyTokenConfigured, not TIKTOK fields', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'vt-test';
    const svc = makeService({
      id: 'ch-wa',
      type: 'WHATSAPP',
      name: 'WhatsApp',
      status: 'ACTIVE',
      agentProfileId: null,
      widgetKey: null,
      externalId: '15551234',
      configPublic: null,
      configSealed: null,
      lastVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [result] = await svc.list('ws-1');
    expect(result.webhookUrl).toBe(`${PUBLIC_BASE_URL}/api/public/channels/meta/webhook`);
    expect(result.verifyTokenConfigured).toBe(true);
    expect(result).not.toHaveProperty('messaging');
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  });
});
