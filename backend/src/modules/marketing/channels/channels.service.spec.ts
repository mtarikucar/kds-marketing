const mockLookup = jest.fn();

// Save-time validation resolves every mail host it is given. Real DNS in a unit
// suite is a flake waiting to happen, so the resolver answers "a public address"
// unless a case says otherwise.
jest.mock('node:dns/promises', () => ({
  __esModule: true,
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';

// Module mock (not jest.spyOn on the namespace object): ESM->CJS emitters that
// define exports as non-configurable getters make namespace spying impossible.
// Only isSecretBoxConfigured is faked, and it CALLS THROUGH to the real
// implementation by default so the suites that never stub it keep the previous
// (unspied) behaviour.
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  ...jest.requireActual('../../../common/crypto/secret-box.helper'),
  isSecretBoxConfigured: jest.fn(),
}));
const actualSecretBox = jest.requireActual<typeof import('../../../common/crypto/secret-box.helper')>(
  '../../../common/crypto/secret-box.helper',
);
const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
beforeEach(() => {
  isSecretBoxConfiguredMock.mockImplementation(actualSecretBox.isSecretBoxConfigured);
});
afterEach(() => {
  isSecretBoxConfiguredMock.mockReset();
});

/** Entitled to all three — matches every real plan block that grants `sms`
 *  alongside `campaigns` (no regression); the one plan block with `sms` but
 *  not `campaigns` is exercised explicitly where it matters (registerIysWebhook). */
function makeEntitlements(features: Record<string, boolean> = { conversationAi: true, sms: true, campaigns: true }) {
  return { getEffective: jest.fn().mockResolvedValue({ features }) } as any;
}

/** The health writer. It only ever DESCRIBES a mailbox, so every suite that is
 *  not about health can hand the service a stub and ignore it. */
function makeHealth() {
  return { clearBackoff: jest.fn().mockResolvedValue(undefined) } as any;
}

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
    const iysClient = {} as any;
    return new ChannelsService(prisma, registry, resolver, makeEntitlements(), iysClient, makeHealth());
  }

  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    // A 32-byte base64 key so netgsmMoCallbackUrl can mint tokens without throwing
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32).toString('base64');
    // Make secret-box helpers safe for tests that don't set up keys
    isSecretBoxConfiguredMock.mockReturnValue(false);
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

/**
 * Focused tests for ChannelsService.verify() — the generic POST
 * /channels/:id/verify path used by ChannelsSettingsPage. It must pass the
 * adapter's healthCheck `details` straight through (unstripped) so the
 * settings UI can distinguish a rejected credential (`credsValid: false`)
 * from a transient/unreachable probe (`credsValid: null`), and surface the
 * provider's diagnostic `message`/`code` as secondary detail.
 */
describe('ChannelsService — verify()', () => {
  function makeVerifyService(
    channelRow: any,
    adapter: { healthCheck: jest.Mock },
    entitlements = makeEntitlements(),
  ) {
    const prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue(channelRow),
        update: jest.fn().mockResolvedValue(channelRow),
      },
    } as any;
    const registry = {
      get: jest.fn().mockReturnValue(adapter),
      resolveConfig: jest.fn().mockReturnValue({
        channelId: channelRow.id,
        workspaceId: channelRow.workspaceId,
        type: channelRow.type,
        externalId: null,
        secrets: {},
        public: {},
      }),
    } as any;
    const resolver = {} as any;
    const iysClient = { registerWebhook: jest.fn() } as any;
    return {
      svc: new ChannelsService(prisma, registry, resolver, entitlements, iysClient, makeHealth()),
      prisma,
      registry,
      entitlements,
      iysClient,
    };
  }

  it('surfaces credsValid:false + message + code so the UI can show a rejected-credential reason', async () => {
    const adapter = {
      healthCheck: jest.fn().mockResolvedValue({
        ok: false,
        details: { credsValid: false, message: 'Kullanıcı adı veya şifre hatalı', code: '30' },
      }),
    };
    const { svc, prisma } = makeVerifyService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS' },
      adapter,
    );
    const result = await svc.verify('ws-1', 'ch-1');
    expect(result.ok).toBe(false);
    expect(result.details).toMatchObject({
      credsValid: false,
      message: 'Kullanıcı adı veya şifre hatalı',
      code: '30',
    });
    // A rejected credential is not a successful verify — lastVerifiedAt must
    // not be bumped.
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('surfaces credsValid:null distinctly from credsValid:false (unreachable vs rejected)', async () => {
    const adapter = {
      healthCheck: jest.fn().mockResolvedValue({
        ok: false,
        details: { credsValid: null, message: null, code: null },
      }),
    };
    const { svc } = makeVerifyService({ id: 'ch-2', workspaceId: 'ws-1', type: 'SMS' }, adapter);
    const result = await svc.verify('ws-1', 'ch-2');
    expect(result.ok).toBe(false);
    expect(result.details?.credsValid).toBeNull();
  });

  it('on success, bumps lastVerifiedAt and still returns details', async () => {
    const adapter = {
      healthCheck: jest.fn().mockResolvedValue({
        ok: true,
        details: { credsValid: true, credit: '100', code: null, message: null },
      }),
    };
    const { svc, prisma } = makeVerifyService({ id: 'ch-3', workspaceId: 'ws-1', type: 'SMS' }, adapter);
    const result = await svc.verify('ws-1', 'ch-3');
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ credsValid: true, credit: '100' });
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'ch-3' },
      data: { lastVerifiedAt: expect.any(Date) },
    });
  });

  // Split off `conversationAi` for the NetGSM SMS v2 program: verifying an SMS
  // channel now requires the `sms` feature specifically; every other type keeps
  // requiring `conversationAi` (unchanged), resolved at runtime from the
  // channel's own `type` since one generic CRUD surface covers every type.
  describe('feature gate (SMS → sms, everything else → conversationAi)', () => {
    it('blocks verifying an SMS channel when the workspace lacks sms (never calls the adapter)', async () => {
      const adapter = { healthCheck: jest.fn() };
      const { svc } = makeVerifyService(
        { id: 'ch-4', workspaceId: 'ws-1', type: 'SMS' },
        adapter,
        makeEntitlements({ conversationAi: true, sms: false }),
      );
      await expect(svc.verify('ws-1', 'ch-4')).rejects.toBeInstanceOf(ForbiddenException);
      expect(adapter.healthCheck).not.toHaveBeenCalled();
    });

    it('blocks verifying a non-SMS channel when the workspace lacks conversationAi', async () => {
      const adapter = { healthCheck: jest.fn() };
      const { svc } = makeVerifyService(
        { id: 'ch-5', workspaceId: 'ws-1', type: 'WHATSAPP' },
        adapter,
        makeEntitlements({ conversationAi: false, sms: true }),
      );
      await expect(svc.verify('ws-1', 'ch-5')).rejects.toBeInstanceOf(ForbiddenException);
      expect(adapter.healthCheck).not.toHaveBeenCalled();
    });

    it('allows verifying an SMS channel on sms alone, even without conversationAi', async () => {
      const adapter = {
        healthCheck: jest.fn().mockResolvedValue({ ok: true, details: {} }),
      };
      const { svc } = makeVerifyService(
        { id: 'ch-6', workspaceId: 'ws-1', type: 'SMS' },
        adapter,
        makeEntitlements({ conversationAi: false, sms: true }),
      );
      const result = await svc.verify('ws-1', 'ch-6');
      expect(result.ok).toBe(true);
      expect(adapter.healthCheck).toHaveBeenCalled();
    });
  });
});

/**
 * Focused tests for ChannelsService.create()/update() — the same per-type
 * feature gate as verify() (SMS → `sms`, everything else → `conversationAi`),
 * checked BEFORE any secret validation/persistence.
 */
describe('ChannelsService — create()/update() feature gate', () => {
  function makeCrudService(entitlements = makeEntitlements()) {
    const prisma = {
      channel: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data, id: 'new-ch' })),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'ch-1', type: 'SMS', ...data })),
        findFirst: jest.fn(),
      },
    } as any;
    const registry = { has: jest.fn().mockReturnValue(true) } as any;
    const resolver = {
      byExternalId: jest.fn().mockResolvedValue(null),
      anyByExternalId: jest.fn().mockResolvedValue(null),
    } as any;
    const iysClient = { registerWebhook: jest.fn() } as any;
    return {
      svc: new ChannelsService(prisma, registry, resolver, entitlements, iysClient, makeHealth()),
      prisma,
      registry,
      entitlements,
    };
  }

  it('create() blocks an SMS channel when the workspace lacks sms', async () => {
    const { svc, prisma } = makeCrudService(makeEntitlements({ conversationAi: true, sms: false }));
    await expect(
      svc.create('ws-1', { type: 'SMS', name: 'SMS line' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it('create() allows an SMS channel on sms alone, even without conversationAi', async () => {
    const { svc, prisma } = makeCrudService(makeEntitlements({ conversationAi: false, sms: true }));
    await svc.create('ws-1', { type: 'SMS', name: 'SMS line' });
    expect(prisma.channel.create).toHaveBeenCalled();
  });

  it('create() blocks a non-SMS channel when the workspace lacks conversationAi', async () => {
    const { svc, prisma } = makeCrudService(makeEntitlements({ conversationAi: false, sms: true }));
    await expect(
      svc.create('ws-1', { type: 'WEBCHAT', name: 'Web chat' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it('update() resolves the feature from the EXISTING channel type (SMS → sms)', async () => {
    const { svc, prisma } = makeCrudService(makeEntitlements({ conversationAi: true, sms: false }));
    prisma.channel.findFirst.mockResolvedValue({ id: 'ch-1', type: 'SMS', configSealed: null });
    await expect(svc.update('ws-1', 'ch-1', { name: 'Renamed' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('update() allows renaming an SMS channel on sms alone', async () => {
    const { svc, prisma } = makeCrudService(makeEntitlements({ conversationAi: false, sms: true }));
    prisma.channel.findFirst.mockResolvedValue({ id: 'ch-1', type: 'SMS', configSealed: null });
    await svc.update('ws-1', 'ch-1', { name: 'Renamed' });
    expect(prisma.channel.update).toHaveBeenCalled();
  });
});

/**
 * Focused tests for ChannelsService.registerIysWebhook() (NetGSM Phase 2
 * Task 4) — mints the workspace's İYS webhook URL and asks NetGSM to
 * register it, using the SMS channel's own sealed usercode/password +
 * configPublic.brandCode. Stamps configPublic.iysWebhookRegistered only on
 * a genuine NetGSM success. Gated on `campaigns` (Task 6 reconciliation —
 * NOT the generic per-type `sms` gate every other channel action uses; see
 * the service method's own doc comment for why).
 */
describe('ChannelsService — registerIysWebhook()', () => {
  const PUBLIC_BASE_URL = 'https://app.example.com';

  function makeRegisterService(
    channelRow: any,
    iysClient: { registerWebhook: jest.Mock } = { registerWebhook: jest.fn() },
    entitlements = makeEntitlements(),
    secrets: Record<string, string> = { usercode: 'u1', password: 'p1' },
  ) {
    const prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue(channelRow),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...channelRow, ...data })),
      },
    } as any;
    const registry = {
      resolveConfig: jest.fn().mockReturnValue({
        channelId: channelRow?.id,
        workspaceId: channelRow?.workspaceId,
        type: channelRow?.type,
        externalId: null,
        secrets,
        public: (channelRow?.configPublic as Record<string, unknown>) ?? {},
      }),
    } as any;
    const resolver = {} as any;
    return {
      svc: new ChannelsService(prisma, registry, resolver, entitlements, iysClient as any, makeHealth()),
      prisma,
      registry,
    };
  }

  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32).toString('base64');
  });

  afterEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('registers the webhook with NetGSM and stamps configPublic.iysWebhookRegistered on success', async () => {
    const iysClient = { registerWebhook: jest.fn().mockResolvedValue({ ok: true, code: '00', message: null }) };
    const { svc, prisma } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: { brandCode: 'BRAND1' } },
      iysClient,
    );

    const result = await svc.registerIysWebhook('ws-1', 'ch-1');

    expect(result.ok).toBe(true);
    expect(iysClient.registerWebhook).toHaveBeenCalledWith(
      { usercode: 'u1', password: 'p1', brandCode: 'BRAND1' },
      expect.stringContaining('/api/public/netgsm/ws-1/'),
    );
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'ch-1' },
      data: { configPublic: { brandCode: 'BRAND1', iysWebhookRegistered: true } },
    });
  });

  it('throws NotFoundException when the channel does not exist (or is not SMS)', async () => {
    const { svc, prisma } = makeRegisterService(null);
    await expect(svc.registerIysWebhook('ws-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('blocks when the workspace lacks the campaigns feature (İYS is bundled with campaigns, not sms)', async () => {
    const iysClient = { registerWebhook: jest.fn() };
    const { svc } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: {} },
      iysClient,
      makeEntitlements({ conversationAi: true, sms: true, campaigns: false }),
    );
    await expect(svc.registerIysWebhook('ws-1', 'ch-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(iysClient.registerWebhook).not.toHaveBeenCalled();
  });

  it('allows registering the webhook on campaigns alone, even without sms (a plan-block edge case, not a real one — every real plan grants sms wherever it grants campaigns)', async () => {
    const iysClient = { registerWebhook: jest.fn().mockResolvedValue({ ok: true, code: '00', message: null }) };
    const { svc } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: { brandCode: 'BRAND1' } },
      iysClient,
      makeEntitlements({ conversationAi: false, sms: false, campaigns: true }),
    );
    const result = await svc.registerIysWebhook('ws-1', 'ch-1');
    expect(result.ok).toBe(true);
  });

  it('throws BadRequestException when the channel has no NetGSM credentials configured yet', async () => {
    const iysClient = { registerWebhook: jest.fn() };
    const { svc } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: { brandCode: 'BRAND1' } },
      iysClient,
      makeEntitlements(),
      {}, // no sealed usercode/password
    );
    await expect(svc.registerIysWebhook('ws-1', 'ch-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(iysClient.registerWebhook).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when brandCode is not configured on the channel', async () => {
    const iysClient = { registerWebhook: jest.fn() };
    const { svc } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: {} }, // no brandCode
      iysClient,
    );
    await expect(svc.registerIysWebhook('ws-1', 'ch-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(iysClient.registerWebhook).not.toHaveBeenCalled();
  });

  it('throws BadRequestException carrying NetGSM\'s message when registration fails', async () => {
    const iysClient = {
      registerWebhook: jest.fn().mockResolvedValue({ ok: false, code: '30', message: 'Kullanıcı adı veya şifre hatalı' }),
    };
    const { svc, prisma } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: { brandCode: 'BRAND1' } },
      iysClient,
    );
    await expect(svc.registerIysWebhook('ws-1', 'ch-1')).rejects.toThrow('Kullanıcı adı veya şifre hatalı');
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableException when PUBLIC_BASE_URL is not configured (no URL to register)', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const iysClient = { registerWebhook: jest.fn() };
    const { svc } = makeRegisterService(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'SMS', configPublic: { brandCode: 'BRAND1' } },
      iysClient,
    );
    await expect(svc.registerIysWebhook('ws-1', 'ch-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(iysClient.registerWebhook).not.toHaveBeenCalled();
  });
});

/**
 * Provider-identity uniqueness.
 *
 * A channel's `externalId` is the handle inbound webhooks route by, and it is
 * SELF-ASSERTED: `secrets` is optional on create, so nothing proves the caller
 * controls the page/phone id it claims. The only thing standing between that
 * and cross-tenant delivery is this guard — which asked `byExternalId`, a
 * routing lookup that filters ACTIVE.
 *
 * So a DISABLED channel's identity read as free, and the whole sequence was
 * reachable from the public API by any MANAGER of any workspace:
 *
 *   1. register the victim's page/phone id (public information, no secrets)
 *   2. PATCH it to DISABLED so it stops blocking the real owner
 *   3. wait for the real owner to connect the number normally
 *   4. PATCH back to ACTIVE — a status-only update, which skipped the check
 *
 * Two ACTIVE rows, one provider identity, and `byExternalId` is a `findFirst`
 * with no ordering: inbound messages land in whichever tenant Postgres scans
 * first. There was no coverage here at all — every existing case omitted
 * `externalId`, so the guard returned at its first line.
 */
describe('ChannelsService — provider identity cannot be claimed twice', () => {
  const OTHER = { id: 'ch-other', workspaceId: 'ws-2', status: 'DISABLED' };

  function make(existing: any = null) {
    const prisma = {
      channel: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data, id: 'new-ch' })),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'ch-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(existing),
      },
    } as any;
    const registry = { has: jest.fn().mockReturnValue(true) } as any;
    const resolver = {
      byExternalId: jest.fn().mockResolvedValue(null),
      anyByExternalId: jest.fn().mockResolvedValue(null),
    } as any;
    const iysClient = { registerWebhook: jest.fn() } as any;
    const svc = new ChannelsService(prisma, registry, resolver, makeEntitlements(), iysClient, makeHealth());
    return { svc, prisma, resolver };
  }

  it('refuses an identity a DISABLED channel in another workspace still holds', async () => {
    const { svc, resolver, prisma } = make();
    resolver.anyByExternalId.mockResolvedValue(OTHER);

    await expect(
      svc.create('ws-1', { type: 'WHATSAPP', name: 'x', externalId: 'PN-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it('asks the status-BLIND lookup, never the ACTIVE-only routing one', async () => {
    const { svc, resolver } = make();

    await svc.create('ws-1', { type: 'WHATSAPP', name: 'x', externalId: 'PN-1' });

    expect(resolver.anyByExternalId).toHaveBeenCalledWith('WHATSAPP', 'PN-1');
    // byExternalId filters ACTIVE — using it here is the defect itself.
    expect(resolver.byExternalId).not.toHaveBeenCalled();
  });

  it('re-checks the identity when a DISABLED channel is switched back to ACTIVE', async () => {
    const { svc, resolver, prisma } = make({
      id: 'ch-1',
      workspaceId: 'ws-1',
      type: 'WHATSAPP',
      status: 'DISABLED',
      externalId: 'PN-1',
    });
    resolver.anyByExternalId.mockResolvedValue({ id: 'ch-other', workspaceId: 'ws-2', status: 'ACTIVE' });

    // Status-only PATCH: the branch that used to skip the check entirely.
    await expect(svc.update('ws-1', 'ch-1', { status: 'ACTIVE' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('lets a channel re-activate onto its OWN identity', async () => {
    const { svc, resolver, prisma } = make({
      id: 'ch-1',
      workspaceId: 'ws-1',
      type: 'WHATSAPP',
      status: 'DISABLED',
      externalId: 'PN-1',
    });
    // The row it finds is itself — excludeId has to make that a non-conflict,
    // or nobody could ever re-enable their own channel.
    resolver.anyByExternalId.mockResolvedValue({ id: 'ch-1', workspaceId: 'ws-1', status: 'DISABLED' });

    await svc.update('ws-1', 'ch-1', { status: 'ACTIVE' });

    expect(prisma.channel.update).toHaveBeenCalled();
  });

  it('does not re-check when a channel is being DISABLED', async () => {
    const { svc, resolver } = make({
      id: 'ch-1',
      workspaceId: 'ws-1',
      type: 'WHATSAPP',
      status: 'ACTIVE',
      externalId: 'PN-1',
    });

    await svc.update('ws-1', 'ch-1', { status: 'DISABLED' });

    // Going quiet releases nothing and can conflict with nothing.
    expect(resolver.anyByExternalId).not.toHaveBeenCalled();
  });
});

/**
 * VOICE channels have to be creatable.
 *
 * The inbound voice-AI path resolves a call to a Channel row — netgsm-ivr
 * matches `type: 'VOICE'` on externalId, voice-ai-bridge loads it by id — and
 * ChannelsService.create() is the ONLY code path in the product that writes a
 * Channel. VOICE was missing from the DTO's CHANNEL_TYPES, so the row could not
 * be created anywhere: the Account Center's Voice "Set up" 400'd on validation
 * and the IVR lookup could only ever find nothing. A whole feature, wired end
 * to end, resting on a row nothing could produce.
 */
describe('ChannelsService — VOICE channels', () => {
  function make(features: Record<string, boolean>) {
    const prisma = {
      channel: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data, id: 'ch-v' })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as any;
    const resolver = {
      byExternalId: jest.fn().mockResolvedValue(null),
      anyByExternalId: jest.fn().mockResolvedValue(null),
    } as any;
    const svc = new ChannelsService(
      prisma,
      { has: jest.fn().mockReturnValue(true) } as any,
      resolver,
      makeEntitlements(features),
      { registerWebhook: jest.fn() } as any,
      makeHealth(),
    );
    return { svc, prisma };
  }

  it('creates a VOICE channel for a telephony workspace', async () => {
    const { svc, prisma } = make({ telephony: true, conversationAi: false });

    await svc.create('ws-1', { type: 'VOICE', name: 'Santral', externalId: '+902121112233' });

    expect(prisma.channel.create).toHaveBeenCalled();
  });

  it('gates VOICE on telephony, not conversationAi', async () => {
    // The default branch would have let this through on conversationAi alone —
    // a voice channel the workspace has no telephony to use.
    const { svc, prisma } = make({ telephony: false, conversationAi: true });

    await expect(
      svc.create('ws-1', { type: 'VOICE', name: 'Santral', externalId: '+902121112233' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });
});

/**
 * Which agent answers on a channel.
 *
 * `agentProfileId` is the single field `ConversationAiEngineService` gates on —
 * null and it declines every inbound message — so this is the switch between a
 * connected inbox that answers and one that only looks like it does. The
 * endpoint took the id raw, and the panel's list happens to be workspace-scoped
 * only in the UI, which is exactly the shape a cross-tenant hole hides in.
 */
describe('ChannelsService.update — binding an answering agent', () => {
  const WS = 'ws-1';
  const CH = { id: 'ch-1', workspaceId: WS, type: 'EMAIL', status: 'ACTIVE' };

  function makeService(agentRow: any) {
    const prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue(CH),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...CH, ...data })),
      },
      agentProfile: { findFirst: jest.fn().mockResolvedValue(agentRow) },
    } as any;
    const svc = new ChannelsService(prisma, {} as any, {} as any, makeEntitlements(), {} as any, makeHealth());
    return { svc, prisma };
  }

  it('attaches an agent that belongs to this workspace', async () => {
    const { svc, prisma } = makeService({ id: 'agent-1' });
    await svc.update(WS, 'ch-1', { agentProfileId: 'agent-1' } as any);
    expect(prisma.channel.update.mock.calls[0][0].data.agentProfileId).toBe('agent-1');
  });

  it('looks the agent up SCOPED to the workspace', async () => {
    // The whole point. An unscoped read would let a channel answer with another
    // tenant's agent — their persona, their guardrails, their knowledge base —
    // replying to this workspace's customers.
    const { svc, prisma } = makeService({ id: 'agent-1' });
    await svc.update(WS, 'ch-1', { agentProfileId: 'agent-1' } as any);
    expect(prisma.agentProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'agent-1', workspaceId: WS } }),
    );
  });

  it('refuses an agent id that is not this workspace', async () => {
    const { svc, prisma } = makeService(null);
    await expect(
      svc.update(WS, 'ch-1', { agentProfileId: 'foreign-agent' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('detaches with null WITHOUT looking anything up', async () => {
    // Handing a channel back to humans must not be blocked by an agent row that
    // has since been deleted — the whole reason you would be detaching.
    const { svc, prisma } = makeService(null);
    await svc.update(WS, 'ch-1', { agentProfileId: null } as any);
    expect(prisma.agentProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.channel.update.mock.calls[0][0].data.agentProfileId).toBeNull();
  });

  it('leaves the binding untouched when the field is not passed', async () => {
    const { svc, prisma } = makeService(null);
    await svc.update(WS, 'ch-1', { name: 'yeni ad' } as any);
    expect(prisma.agentProfile.findFirst).not.toHaveBeenCalled();
    expect('agentProfileId' in prisma.channel.update.mock.calls[0][0].data).toBe(false);
  });
});

/**
 * Connecting a mailbox, end to end.
 *
 * Four separate defects meet in `create()`/`update()`, and they all have the
 * same shape: the save succeeds and the truth arrives later, somewhere the
 * person who typed it will never look.
 *
 *  - `smtp-ssrf` — an unchecked host makes Verify an internal port scanner, and
 *    the write path is the choke point that closes verify, send and both IMAP
 *    services at once.
 *  - `mailbox-not-auto-verified` — nothing proved the mailbox, so
 *    `lastVerifiedAt` stayed null, so the pollers and the sender skipped it
 *    while the dialog said "replies will flow".
 *  - `externalid-claim` — the address was claimed on nothing but the claim.
 *  - `email-gated-conversationai` — the refusal did not say what was missing.
 */
describe('ChannelsService — connecting a mailbox', () => {
  const PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }];
  const SMTP = {
    smtpHost: 'smtp.firma.com.tr',
    smtpPort: '587',
    smtpUser: 'info@firma.com.tr',
    smtpPass: 'hunter2',
    fromEmail: 'info@firma.com.tr',
  };

  function make(opts: {
    health?: { ok: boolean; details?: Record<string, unknown> };
    healthCheck?: jest.Mock;
    existing?: any;
    pendingRows?: any[];
    sendingDomain?: any;
    entitlements?: any;
  } = {}) {
    const healthCheck =
      opts.healthCheck ?? jest.fn().mockResolvedValue(opts.health ?? { ok: true, details: {} });
    const prisma = {
      channel: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data, id: 'ch-new' })),
        update: jest.fn().mockImplementation(({ where, data }: any) =>
          Promise.resolve({ ...(opts.existing ?? {}), id: where.id, ...data }),
        ),
        findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
        findMany: jest.fn().mockResolvedValue(opts.pendingRows ?? []),
      },
      sendingDomain: { findFirst: jest.fn().mockResolvedValue(opts.sendingDomain ?? null) },
    } as any;
    const registry = {
      has: jest.fn().mockReturnValue(true),
      get: jest.fn().mockReturnValue({ healthCheck }),
      resolveConfig: jest.fn().mockReturnValue({ secrets: {}, public: {} }),
    } as any;
    const resolver = { anyByExternalId: jest.fn().mockResolvedValue(null), byExternalId: jest.fn() } as any;
    const health = makeHealth();
    const svc = new ChannelsService(
      prisma,
      registry,
      resolver,
      opts.entitlements ?? makeEntitlements(),
      { registerWebhook: jest.fn() } as any,
      health,
    );
    return { svc, prisma, registry, resolver, health, healthCheck };
  }

  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue(PUBLIC_DNS);
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32).toString('base64');
    process.env.PUBLIC_BASE_URL = 'https://app.example.com';
    isSecretBoxConfiguredMock.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.EMAIL_FROM;
  });

  describe('the credentials are checked before they are sealed', () => {
    it('refuses an SMTP host that resolves inside our own network', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const { svc, prisma } = make();

      await expect(
        svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.channel.create).not.toHaveBeenCalled();
    });

    it('refuses a From that is not an address', async () => {
      const { svc, prisma } = make();

      await expect(
        svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: { ...SMTP, fromEmail: 'hi there' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.channel.create).not.toHaveBeenCalled();
    });

    it("refuses a From on the platform's own domain", async () => {
      // jeetagrowth.com is DMARC p=reject with SPF -all and no tenant key: mail
      // sent as it from a tenant's relay is rejected outright, and it would let
      // one tenant mail the world as the platform.
      process.env.EMAIL_FROM = 'no-reply@jeetagrowth.com';
      const { svc } = make();

      await expect(
        svc.create('ws-1', {
          type: 'EMAIL',
          name: 'Mailbox',
          secrets: { ...SMTP, fromEmail: 'destek@jeetagrowth.com' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts an ESP relay whose login is not an address', async () => {
      const { svc, prisma } = make();

      await svc.create('ws-1', {
        type: 'EMAIL',
        name: 'Mailbox',
        secrets: { ...SMTP, smtpUser: 'apikey', smtpPass: 'SG.xxx' },
      });

      expect(prisma.channel.create).toHaveBeenCalled();
    });

    it('checks the MERGED secrets on update, not just the ones being written', async () => {
      mockLookup.mockImplementation(async (host: string) =>
        host === 'imap.internal' ? [{ address: '127.0.0.1', family: 4 }] : PUBLIC_DNS,
      );
      const { svc, prisma } = make({
        existing: { id: 'ch-1', workspaceId: 'ws-1', type: 'EMAIL', configSealed: null, configPublic: null },
      });

      await expect(
        svc.update('ws-1', 'ch-1', { secrets: { imapHost: 'imap.internal' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.channel.update).not.toHaveBeenCalled();
    });

    it('leaves a non-EMAIL channel alone', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const { svc, prisma } = make();

      await svc.create('ws-1', {
        type: 'WEBCHAT',
        name: 'Widget',
        secrets: { smtpHost: 'mail.internal' },
      });

      expect(prisma.channel.create).toHaveBeenCalled();
    });
  });

  describe('a mailbox proves itself on save', () => {
    it('verifies a new channel and stamps lastVerifiedAt', async () => {
      const { svc, prisma, healthCheck } = make({ health: { ok: true, details: { send: true } } });

      const result: any = await svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP });

      expect(healthCheck).toHaveBeenCalled();
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: { id: 'ch-new' },
        data: { lastVerifiedAt: expect.any(Date) },
      });
      // The dialog cannot say "replies will flow" honestly without this.
      expect(result.health).toMatchObject({ ok: true, details: { send: true } });
    });

    it('keeps the channel when the check fails, and does not claim it is verified', async () => {
      // Losing the row would discard the typed password and the imapHost the
      // operator just entered — and would break the WhatsApp signup, where the
      // channel must exist before the WABA subscription propagates.
      const { svc, prisma } = make({ health: { ok: false, details: { reason: '535 bad password' } } });

      const result: any = await svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP });

      expect(result.id).toBe('ch-new');
      expect(result.health).toMatchObject({ ok: false });
      expect(prisma.channel.update).not.toHaveBeenCalled();
    });

    it('keeps the channel when the check THROWS', async () => {
      const { svc } = make({ healthCheck: jest.fn().mockRejectedValue(new Error('boom')) });

      const result: any = await svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP });

      expect(result.id).toBe('ch-new');
      expect(result.health.ok).toBe(false);
    });

    it('does not hang the save on a mail server that never answers', async () => {
      jest.useFakeTimers();
      try {
        const { svc } = make({ healthCheck: jest.fn().mockReturnValue(new Promise(() => undefined)) });

        const pending = svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP });
        await jest.advanceTimersByTimeAsync(60_000);

        const result: any = await pending;
        expect(result.id).toBe('ch-new');
        expect(result.health.ok).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('proves nothing when there is nothing to prove', async () => {
      const { svc, healthCheck } = make();

      await svc.create('ws-1', { type: 'WEBCHAT', name: 'Widget' });

      expect(healthCheck).not.toHaveBeenCalled();
    });

    it('re-verifies on a credential edit only', async () => {
      const existing = { id: 'ch-1', workspaceId: 'ws-1', type: 'EMAIL', configSealed: null, configPublic: null };
      const { svc, healthCheck } = make({ existing });

      await svc.update('ws-1', 'ch-1', { name: 'Yeni ad' });
      expect(healthCheck).not.toHaveBeenCalled();

      await svc.update('ws-1', 'ch-1', { secrets: SMTP });
      expect(healthCheck).toHaveBeenCalled();
    });

    it('unplugs a mailbox whose password was rotated away', async () => {
      // The hole workspace-readiness documents: a rotated password kept reading
      // READY forever because nothing ever cleared the stamp.
      const existing = {
        id: 'ch-1',
        workspaceId: 'ws-1',
        type: 'EMAIL',
        configSealed: null,
        configPublic: null,
        lastVerifiedAt: new Date('2026-01-01'),
      };
      const { svc, prisma } = make({
        existing,
        health: { ok: false, details: { transport: 'smtp', reason: '535 Username and Password not accepted' } },
      });

      await svc.update('ws-1', 'ch-1', { secrets: SMTP });

      expect(prisma.channel.update).toHaveBeenLastCalledWith({
        where: { id: 'ch-1' },
        data: { lastVerifiedAt: null },
      });
    });

    it('does NOT unplug a working mailbox over an unreachable probe', async () => {
      // A DNS blip or a timeout is not evidence that the credentials are wrong,
      // and clearing the stamp would stop IMAP for every reply until a human
      // noticed and pressed Verify.
      const existing = {
        id: 'ch-1',
        workspaceId: 'ws-1',
        type: 'EMAIL',
        configSealed: null,
        configPublic: null,
        lastVerifiedAt: new Date('2026-01-01'),
      };
      const { svc, prisma } = make({
        existing,
        health: { ok: false, details: { transport: 'smtp', reason: 'getaddrinfo EAI_AGAIN smtp.firma.com.tr' } },
      });

      await svc.update('ws-1', 'ch-1', { secrets: SMTP });

      expect(prisma.channel.update).toHaveBeenCalledTimes(1); // the secrets write only
    });
  });

  describe('the address is claimed only with proof', () => {
    it('parks an unproven address instead of claiming it', async () => {
      const { svc, prisma } = make();

      await svc.create('ws-1', {
        type: 'EMAIL',
        name: 'Mailbox',
        externalId: 'INFO@firma.com.tr',
        secrets: SMTP,
      });

      const { data } = prisma.channel.create.mock.calls[0][0];
      expect(data.externalId).toBeNull();
      expect(data.configPublic).toMatchObject({ pendingAddress: 'info@firma.com.tr' });
    });

    it('does not block the real owner with a stranger\'s claim', async () => {
      // The defect: a rival registered info@rakip.com.tr — no secrets needed —
      // and the real business got a 409 forever.
      const { svc, prisma, resolver } = make();
      resolver.anyByExternalId.mockResolvedValue({ id: 'ch-squat', workspaceId: 'ws-2' });

      await svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', externalId: 'info@firma.com.tr' });

      expect(prisma.channel.create).toHaveBeenCalled();
    });

    it('claims the address when a verified sending domain proves it', async () => {
      const { svc, prisma } = make({ sendingDomain: { id: 'sd-1' } });

      await svc.create('ws-1', {
        type: 'EMAIL',
        name: 'Mailbox',
        externalId: 'info@firma.com.tr',
        secrets: SMTP,
      });

      const { data } = prisma.channel.create.mock.calls[0][0];
      expect(data.externalId).toBe('info@firma.com.tr');
      expect(data.configPublic?.pendingAddress).toBeUndefined();
    });

    it('still refuses a proven claim on an address another channel owns', async () => {
      const { svc, resolver } = make({ sendingDomain: { id: 'sd-1' } });
      resolver.anyByExternalId.mockResolvedValue({ id: 'ch-other', workspaceId: 'ws-2' });

      await expect(
        svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', externalId: 'info@firma.com.tr' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('re-connects the parked mailbox instead of parking it twice', async () => {
      // Unproven both times: the row that is already waiting on this address is
      // the row this connect means, and a second parked row would split one
      // mailbox in two (nothing collides on the unique index any more).
      const parked = {
        id: 'ch-parked',
        workspaceId: 'ws-1',
        type: 'EMAIL',
        externalId: null,
        configSealed: null,
        configPublic: { pendingAddress: 'info@firma.com.tr', inboundPolicy: 'REPLIES_AND_KNOWN' },
      };
      const { svc, prisma } = make({ existing: parked, pendingRows: [parked] });

      const result: any = await svc.create('ws-1', {
        type: 'EMAIL',
        name: 'Mailbox',
        externalId: 'info@firma.com.tr',
        secrets: SMTP,
      });

      expect(prisma.channel.create).not.toHaveBeenCalled();
      expect(result.id).toBe('ch-parked');
      const { data } = prisma.channel.update.mock.calls[0][0];
      expect(data.externalId).toBeNull();
      expect(data.configPublic.pendingAddress).toBe('info@firma.com.tr');
    });

    it('promotes the parked channel when proof arrives, instead of making a second one', async () => {
      // EmailOAuthService looks its channel up by externalId; against a parked
      // row that misses, and a blind create would leave the workspace with two
      // channels for one mailbox.
      const parked = {
        id: 'ch-parked',
        workspaceId: 'ws-1',
        type: 'EMAIL',
        externalId: null,
        configSealed: null,
        configPublic: { pendingAddress: 'info@firma.com.tr', inboundPolicy: 'REPLIES_AND_KNOWN' },
      };
      const { svc, prisma } = make({
        existing: parked,
        pendingRows: [parked],
        sendingDomain: { id: 'sd-1' },
      });

      const result: any = await svc.create('ws-1', {
        type: 'EMAIL',
        name: 'Mailbox',
        externalId: 'info@firma.com.tr',
        secrets: SMTP,
      });

      expect(prisma.channel.create).not.toHaveBeenCalled();
      expect(result.id).toBe('ch-parked');
      const { data } = prisma.channel.update.mock.calls[0][0];
      expect(data.externalId).toBe('info@firma.com.tr');
      expect(data.configPublic.pendingAddress).toBeUndefined();
      expect(data.configPublic.inboundPolicy).toBe('REPLIES_AND_KNOWN');
    });
  });

  describe('a new mailbox starts on the narrow inbound policy', () => {
    it('stamps REPLIES_AND_KNOWN on a channel connected from now on', async () => {
      const { svc, prisma } = make();

      await svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP });

      expect(prisma.channel.create.mock.calls[0][0].data.configPublic).toMatchObject({
        inboundPolicy: 'REPLIES_AND_KNOWN',
      });
    });

    it('keeps an explicit choice', async () => {
      const { svc, prisma } = make();

      await svc.create('ws-1', {
        type: 'EMAIL',
        name: 'Mailbox',
        secrets: SMTP,
        configPublic: { inboundPolicy: 'ALL_SENDERS' },
      });

      expect(prisma.channel.create.mock.calls[0][0].data.configPublic).toMatchObject({
        inboundPolicy: 'ALL_SENDERS',
      });
    });

    it('does not put the knob on a channel that has no inbox', async () => {
      const { svc, prisma } = make();

      await svc.create('ws-1', { type: 'WEBCHAT', name: 'Widget' });

      expect(prisma.channel.create.mock.calls[0][0].data.configPublic).toBeUndefined();
    });
  });

  describe('verify() lets a fixed mailbox try again at once', () => {
    it('clears the inbound backoff when the operator re-proves the credentials', async () => {
      const { svc, health } = make({
        existing: { id: 'ch-1', workspaceId: 'ws-1', type: 'EMAIL' },
        health: { ok: true, details: {} },
      });

      await svc.verify('ws-1', 'ch-1');

      expect(health.clearBackoff).toHaveBeenCalledWith({ id: 'ch-1', workspaceId: 'ws-1' });
    });

    it('does not clear it on a failed verify', async () => {
      const { svc, health } = make({
        existing: { id: 'ch-1', workspaceId: 'ws-1', type: 'EMAIL' },
        health: { ok: false, details: {} },
      });

      await svc.verify('ws-1', 'ch-1');

      expect(health.clearBackoff).not.toHaveBeenCalled();
    });

    it('answers with a reason instead of a 500 when the adapter throws', async () => {
      const { svc } = make({
        existing: { id: 'ch-1', workspaceId: 'ws-1', type: 'EMAIL' },
        healthCheck: jest.fn().mockRejectedValue(new Error('socket hang up')),
      });

      const result = await svc.verify('ws-1', 'ch-1');

      expect(result.ok).toBe(false);
      expect(String(result.details?.reason)).toContain('socket hang up');
    });
  });

  describe('the refusal names what is missing', () => {
    it('says which plan item a mailbox needs, not "a higher package"', async () => {
      // The live workspace hits this and has to know WHAT to switch on. The
      // gate itself stays where it is: `assertChannelFeature` covers create,
      // update and verify, while the channel list, the delete route and every
      // conversations route gate on `conversationAi` independently — so moving
      // EMAIL onto its own key would only buy a connect-succeeds/inbox-403.
      const { svc } = make({ entitlements: makeEntitlements({ conversationAi: false }) });

      await expect(
        svc.create('ws-1', { type: 'EMAIL', name: 'Mailbox', secrets: SMTP }),
      ).rejects.toMatchObject({
        response: {
          code: 'FEATURE_NOT_IN_PACKAGE',
          feature: 'conversationAi',
          featureLabel: expect.stringMatching(/Conversations/i),
        },
      });
    });
  });
});

/**
 * The inbound URL the tenant actually pastes into their relay.
 *
 * The legacy `POST webhook` needs a platform-global HMAC no inbound-parse
 * provider can produce, so every tenant who followed the dialog got a silent
 * 401 — and sharing that one secret would let any holder forge mail into any
 * workspace. The per-channel URL names the tenant, so it needs no secret of its
 * own and cannot address anybody else's mailbox.
 */
describe('ChannelsService — mask() exposes the tokenized inbound URL', () => {
  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = 'https://app.example.com';
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32).toString('base64');
    isSecretBoxConfiguredMock.mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.MARKETING_SECRET_KEY;
  });

  function make(row: any) {
    const prisma = { channel: { findMany: jest.fn().mockResolvedValue([row]) } } as any;
    return new ChannelsService(prisma, {} as any, {} as any, makeEntitlements(), {} as any, makeHealth());
  }

  it('gives an EMAIL channel a URL that carries its own id and token', async () => {
    const svc = make({
      id: 'ch-mail',
      type: 'EMAIL',
      name: 'Mailbox',
      status: 'ACTIVE',
      externalId: 'info@firma.com.tr',
      configPublic: null,
      configSealed: null,
    });

    const [result] = await svc.list('ws-1');

    expect(result.inboundUrl).toMatch(
      /^https:\/\/app\.example\.com\/api\/public\/channels\/email\/ch-mail\/[0-9a-f]{64}\/inbound$/,
    );
    // The legacy signed route keeps its place — a custom relay may already sign it.
    expect(result.webhookUrl).toBe('https://app.example.com/api/public/channels/email/webhook');
  });

  it('surfaces a parked address so the card can say which mailbox is meant', async () => {
    const svc = make({
      id: 'ch-mail',
      type: 'EMAIL',
      name: 'Mailbox',
      status: 'ACTIVE',
      externalId: null,
      configPublic: { pendingAddress: 'info@firma.com.tr' },
      configSealed: null,
    });

    const [result] = await svc.list('ws-1');

    expect(result.inboundAddress).toBeNull();
    expect(result.pendingAddress).toBe('info@firma.com.tr');
  });

  it('gives a non-EMAIL channel no inbound URL at all', async () => {
    const svc = make({
      id: 'ch-sms',
      type: 'SMS',
      name: 'SMS',
      status: 'ACTIVE',
      externalId: null,
      configPublic: null,
      configSealed: null,
    });

    const [result] = await svc.list('ws-1');

    expect(result).not.toHaveProperty('inboundUrl');
  });
});

describe('ChannelsService — a settings save must not wipe the machines\' place', () => {
  function make(existing: any) {
    const prisma = {
      channel: {
        create: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'ch-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(existing),
      },
    } as any;
    const registry = { has: jest.fn().mockReturnValue(true) } as any;
    const resolver = {
      byExternalId: jest.fn().mockResolvedValue(null),
      anyByExternalId: jest.fn().mockResolvedValue(null),
    } as any;
    const svc = new ChannelsService(
      prisma,
      registry,
      resolver,
      makeEntitlements(),
      { registerWebhook: jest.fn() } as any,
      makeHealth(),
    );
    return { svc, prisma };
  }

  const MAILBOX = {
    id: 'ch-1',
    workspaceId: 'ws-1',
    type: 'EMAIL',
    status: 'ACTIVE',
    externalId: 'destek@acme.test',
    configSealed: null,
    configPublic: {
      imapLastUid: 4210,
      imapUidValidity: '42',
      imapFailUid: 4211,
      imapFailCount: 2,
      imapSentLastUid: 900,
      health: { receive: { ok: false, backoffUntil: '2026-09-23T10:00:00.000Z' } },
      fromName: 'Acme',
    },
  };

  it('keeps the IMAP cursor, the poison counters and the health block', async () => {
    // Replacing the whole JSON resets the cursor, so the next tick reads the
    // mailbox as a FIRST RUN and holds the automation on a week of live
    // replies — and drops the backoff a dead credential earned.
    const { svc, prisma } = make(MAILBOX);
    await svc.update('ws-1', 'ch-1', { configPublic: { inboundPolicy: 'REPLIES_AND_KNOWN' } });
    const written = prisma.channel.update.mock.calls[0][0].data.configPublic;
    expect(written).toMatchObject({
      imapLastUid: 4210,
      imapUidValidity: '42',
      imapFailUid: 4211,
      imapFailCount: 2,
      imapSentLastUid: 900,
      health: { receive: { ok: false, backoffUntil: '2026-09-23T10:00:00.000Z' } },
    });
  });

  it('still applies what the dialog actually changed', async () => {
    const { svc, prisma } = make(MAILBOX);
    await svc.update('ws-1', 'ch-1', {
      configPublic: { inboundPolicy: 'REPLIES_AND_KNOWN', fromName: 'Acme Destek' },
    });
    const written = prisma.channel.update.mock.calls[0][0].data.configPublic;
    expect(written.inboundPolicy).toBe('REPLIES_AND_KNOWN');
    expect(written.fromName).toBe('Acme Destek');
  });
});
