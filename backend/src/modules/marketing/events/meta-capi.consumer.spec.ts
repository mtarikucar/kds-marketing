import { createHash } from 'node:crypto';
import { MetaCapiConsumer } from './meta-capi.consumer';
import { MarketingEventTypes } from './marketing-event-types';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';
import {
  sha256,
  toE164Digits,
  buildFbc,
  sendConversionEvent,
} from '../ads/meta-capi.client';

// Keep isMetaAuthError / appSecretProof real; stub only the network call.
jest.mock('../../../common/util/meta-graph.util', () => ({
  ...jest.requireActual('../../../common/util/meta-graph.util'),
  metaGraphFetch: jest.fn(),
}));
// openSecret is identity in tests (the "sealed" token is passed through).
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  openSecret: jest.fn((s: string) => s),
}));

const mockGraph = metaGraphFetch as jest.Mock;

const hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

describe('meta-capi.client helpers', () => {
  it('sha256 normalizes (lowercase/trim) then hashes, and omits empties', () => {
    expect(sha256('  Ada@X.com ')).toBe(hex('ada@x.com'));
    expect(sha256('')).toBeUndefined();
    expect(sha256(null)).toBeUndefined();
  });

  it('toE164Digits prefixes the TR country code for a leading-0 local number', () => {
    expect(toE164Digits('05551112233')).toBe('905551112233');
    expect(toE164Digits('905551112233')).toBe('905551112233'); // already international
    expect(toE164Digits('5551112233')).toBe('905551112233'); // bare national
    expect(toE164Digits('')).toBeUndefined();
  });

  it('buildFbc emits fb.1.<ts>.<fbclid>', () => {
    const at = new Date('2026-07-01T00:00:00Z');
    expect(buildFbc('abc123', at)).toBe(`fb.1.${at.getTime()}.abc123`);
    expect(buildFbc(null, at)).toBeUndefined();
  });

  it('sendConversionEvent POSTs to /<pixelId>/events with a data array', async () => {
    mockGraph.mockResolvedValue({ ok: true });
    await sendConversionEvent('TOK', 'PIX', { event_name: 'Purchase' } as any);
    expect(mockGraph).toHaveBeenCalledWith(
      '/PIX/events',
      expect.objectContaining({ accessToken: 'TOK', method: 'POST', body: expect.objectContaining({ data: [{ event_name: 'Purchase' }] }) }),
    );
  });
});

describe('MetaCapiConsumer', () => {
  const WS = 'ws-1';
  let prisma: any;
  let bus: { on: jest.Mock; off: jest.Mock };
  let svc: MetaCapiConsumer;

  const account = {
    id: 'acc-1',
    pixelId: 'PIXEL-9',
    capiToken: null,
    accessToken: 'sealed-token',
    currency: 'TRY',
  };
  const lead = { emailNormalized: 'ada@x.com', phoneNormalized: '05551112233', city: 'Istanbul' };
  const attribution = {
    clickId: 'fbclid-xyz',
    clickIdType: 'FBCLID',
    ctwaClid: 'ctwa-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };

  beforeEach(() => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    delete process.env.META_CAPI_TEST_EVENT_CODE;
    prisma = {
      adAccount: {
        findFirst: jest.fn().mockResolvedValue(account),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { findUnique: jest.fn().mockResolvedValue(lead) },
      leadAttribution: { findUnique: jest.fn().mockResolvedValue(attribution) },
    };
    bus = { on: jest.fn(), off: jest.fn() };
    mockGraph.mockReset().mockResolvedValue({ ok: true, error: null });
    svc = new MetaCapiConsumer(prisma as any, bus as any);
  });

  const ev = (type: string, payload: any) => ({
    id: 'evt-100',
    type,
    tenantId: null,
    payload,
    idempotencyKey: 'k',
    createdAt: new Date(),
  });

  it('subscribes to OpportunityWon + InvoicePaid on init and detaches on destroy', () => {
    svc.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.OpportunityWon, expect.any(Function));
    expect(bus.on).toHaveBeenCalledWith(MarketingEventTypes.InvoicePaid, expect.any(Function));
    svc.onModuleDestroy();
    expect(bus.off).toHaveBeenCalledTimes(2);
  });

  it('InvoicePaid → Purchase with minor→major value, hashed PII, fbc, ctwa_clid, and event_id = event.id', async () => {
    svc.onModuleInit();
    const handler = bus.on.mock.calls.find((c) => c[0] === MarketingEventTypes.InvoicePaid)![1];
    await handler(ev(MarketingEventTypes.InvoicePaid, {
      workspaceId: WS,
      invoiceId: 'inv-1',
      leadId: 'lead-1',
      total: 15000, // 150.00 TRY in kuruş
      currency: 'TRY',
      via: 'wallet',
      occurredAt: '2026-07-02T00:00:00Z',
    }));

    expect(mockGraph).toHaveBeenCalledTimes(1);
    const [path, opts] = mockGraph.mock.calls[0];
    expect(path).toBe('/PIXEL-9/events');
    const event = opts.body.data[0];
    expect(event).toMatchObject({
      event_name: 'Purchase',
      event_id: 'evt-100',
      action_source: 'system_generated',
      custom_data: { value: 150, currency: 'TRY' },
    });
    expect(event.user_data.em).toBe(hex('ada@x.com'));
    expect(event.user_data.ph).toBe(hex('905551112233'));
    expect(event.user_data.fbc).toBe(`fb.1.${attribution.createdAt.getTime()}.fbclid-xyz`);
    expect(event.user_data.ctwa_clid).toBe('ctwa-1');
  });

  it('OpportunityWon → value passed through as major units; currency falls back to the account currency', async () => {
    svc.onModuleInit();
    const handler = bus.on.mock.calls.find((c) => c[0] === MarketingEventTypes.OpportunityWon)![1];
    await handler(ev(MarketingEventTypes.OpportunityWon, {
      workspaceId: WS,
      opportunityId: 'opp-1',
      leadId: 'lead-1',
      value: 2500, // major units
      occurredAt: '2026-07-02T00:00:00Z',
    }));
    const event = mockGraph.mock.calls[0][1].body.data[0];
    expect(event.custom_data).toEqual({ value: 2500, currency: 'TRY' });
  });

  it('skips when the workspace has no META account with a pixel', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ ...account, pixelId: null });
    await (svc as any).send('evt-1', WS, 'lead-1', { value: 10, currency: 'TRY', occurredAt: '2026-07-02T00:00:00Z' });
    expect(mockGraph).not.toHaveBeenCalled();
  });

  it('skips when the platform Meta creds are absent (ships dark)', async () => {
    delete process.env.META_APP_ID;
    await (svc as any).send('evt-1', WS, 'lead-1', { value: 10, currency: 'TRY', occurredAt: '2026-07-02T00:00:00Z' });
    expect(prisma.adAccount.findFirst).not.toHaveBeenCalled();
    expect(mockGraph).not.toHaveBeenCalled();
  });

  it('skips the call when there is no match key (no lead → no PII/click id)', async () => {
    await (svc as any).send('evt-1', WS, null, { value: 10, currency: 'TRY', occurredAt: '2026-07-02T00:00:00Z' });
    expect(mockGraph).not.toHaveBeenCalled();
  });

  it('flips the account to TOKEN_EXPIRED on a Meta auth error', async () => {
    mockGraph.mockResolvedValue({ ok: false, status: 401, error: { isAuthError: true, message: 'bad token' } });
    await (svc as any).send('evt-1', WS, 'lead-1', { value: 10, currency: 'TRY', occurredAt: '2026-07-02T00:00:00Z' });
    expect(prisma.adAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'acc-1' }, data: expect.objectContaining({ status: 'TOKEN_EXPIRED' }) }),
    );
  });
});
