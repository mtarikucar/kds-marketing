import { createHmac } from 'crypto';
import { MetaWebhookController } from './meta-webhook.controller';

/**
 * The Meta webhook's trust boundary is the X-Hub-Signature-256 HMAC over the
 * RAW bytes + the GET verify-token challenge. These guard against spoofed
 * inbound events, so they get a focused spec.
 */
describe('MetaWebhookController — signature + challenge', () => {
  const SECRET = 'test-app-secret';
  let controller: MetaWebhookController;

  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me';
    controller = new MetaWebhookController(
      {} as any,
      { has: () => false } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  function sign(raw: Buffer): string {
    return 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  }

  it('accepts a correctly-signed payload', () => {
    const raw = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));
    expect((controller as any).validSignature(raw, sign(raw))).toBe(true);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const raw = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));
    const sig = sign(raw);
    const tampered = Buffer.from(JSON.stringify({ object: 'page', entry: [{ evil: true }] }));
    expect((controller as any).validSignature(tampered, sig)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const raw = Buffer.from('{}');
    expect((controller as any).validSignature(raw, undefined)).toBe(false);
  });

  it('rejects when no app secret is configured', () => {
    delete process.env.META_APP_SECRET;
    const raw = Buffer.from('{}');
    expect((controller as any).validSignature(raw, sign(raw))).toBe(false);
  });

  it('GET verify echoes the challenge only when the verify token matches', () => {
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    controller.verify(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' } as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('12345');

    const res2: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    controller.verify(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'WRONG', 'hub.challenge': '12345' } as any,
      res2,
    );
    expect(res2.status).toHaveBeenCalledWith(403);
  });

  it('routes a mixed multi-number WABA entry PER CHANGE — each phone number to ITS OWN channel/workspace', async () => {
    // One WABA entry batches changes[] spanning DIFFERENT phone numbers; each
    // number is an independent Channel row, possibly in a different workspace.
    // Resolving once per entry used to route EVERY message in the entry to
    // whichever number appeared first (cross-tenant misroute) and apply the
    // other number's receipts under the wrong workspaceId (silent no-op).
    const ingest = jest.fn().mockResolvedValue(undefined);
    const apply = jest.fn().mockResolvedValue(undefined);
    const adapter = {
      // Echo back one inbound per change so routing is observable.
      parseInbound: (_cfg: any, payload: any) => {
        const change = payload.entry[0].changes[0];
        return change.value.messages
          ? [{ externalMessageId: change.value.messages[0].id, from: 'x', text: 'hi' }]
          : [];
      },
      parseStatusUpdates: (_cfg: any, payload: any) => {
        const change = payload.entry[0].changes[0];
        return (change.value.statuses ?? []).map((s: any) => ({
          externalMessageId: s.id,
          status: 'DELIVERED' as const,
        }));
      },
    };
    const registry = { has: () => true, get: () => adapter, resolveConfig: () => ({}) };
    const byExternalId = jest.fn(async (_type: string, id: string) =>
      id === 'PN-A'
        ? { id: 'ch-A', workspaceId: 'ws-A', type: 'WHATSAPP', externalId: 'PN-A' }
        : { id: 'ch-B', workspaceId: 'ws-B', type: 'WHATSAPP', externalId: 'PN-B' },
    );
    const ctrl = new MetaWebhookController(
      { byExternalId } as any,
      registry as any,
      { ingest } as any,
      { apply } as any,
      { ingest: jest.fn() } as any,
    );
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-1',
          changes: [
            { value: { metadata: { phone_number_id: 'PN-A' }, messages: [{ id: 'wamid.A' }] } },
            { value: { metadata: { phone_number_id: 'PN-B' }, statuses: [{ id: 'wamid.B', status: 'delivered' }] } },
          ],
        },
      ],
    };
    await (ctrl as any).process(body);

    // Each phone number resolved individually…
    expect(byExternalId).toHaveBeenCalledWith('WHATSAPP', 'PN-A');
    expect(byExternalId).toHaveBeenCalledWith('WHATSAPP', 'PN-B');
    // …the message landed in A's workspace, and B's receipt in B's workspace.
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch-A', workspaceId: 'ws-A' }),
      expect.objectContaining({ externalMessageId: 'wamid.A' }),
    );
    expect(apply).toHaveBeenCalledWith('ws-B', [
      { externalMessageId: 'wamid.B', status: 'DELIVERED' },
    ]);
  });

  it('applies delivery/read receipts through MessageReceiptService', async () => {
    const apply = jest.fn();
    const adapter = {
      parseInbound: () => [],
      parseStatusUpdates: () => [{ externalMessageId: 'wamid.1', status: 'DELIVERED' as const }],
    };
    const registry = { has: () => true, get: () => adapter, resolveConfig: () => ({}) };
    const resolver = {
      byExternalId: jest.fn().mockResolvedValue({ id: 'c1', workspaceId: 'w1', type: 'WHATSAPP' }),
    };
    const ctrl = new MetaWebhookController(
      resolver as any,
      registry as any,
      { ingest: jest.fn() } as any,
      { apply } as any,
      { ingest: jest.fn() } as any,
    );
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        { changes: [{ value: { metadata: { phone_number_id: 'PN' }, statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] },
      ],
    };
    await (ctrl as any).process(body);
    expect(apply).toHaveBeenCalledWith('w1', [{ externalMessageId: 'wamid.1', status: 'DELIVERED' }]);
  });

  it('routes a page leadgen change to the leadgen ingest with the resolved channel + config', async () => {
    const ingestLeadgen = jest.fn().mockResolvedValue(undefined);
    const adapter = { parseInbound: () => [], parseStatusUpdates: () => [] };
    const config = { secrets: { pageAccessToken: 'PT' } };
    const registry = { has: () => true, get: () => adapter, resolveConfig: () => config };
    const resolver = {
      byExternalId: jest.fn().mockResolvedValue({
        id: 'c1',
        workspaceId: 'w1',
        type: 'MESSENGER',
        externalId: 'page-7',
      }),
    };
    const ctrl = new MetaWebhookController(
      resolver as any,
      registry as any,
      { ingest: jest.fn() } as any,
      { apply: jest.fn() } as any,
      { ingest: ingestLeadgen } as any,
    );
    const body = {
      object: 'page',
      entry: [{ id: 'page-7', changes: [{ field: 'leadgen', value: { leadgen_id: 'lg-1', form_id: 'f1' } }] }],
    };
    await (ctrl as any).process(body);
    expect(ingestLeadgen).toHaveBeenCalledTimes(1);
    expect(ingestLeadgen.mock.calls[0][0]).toEqual({ id: 'c1', workspaceId: 'w1', externalId: 'page-7' });
    expect(ingestLeadgen.mock.calls[0][1]).toBe(config);
    expect(ingestLeadgen.mock.calls[0][2]).toEqual({ leadgen_id: 'lg-1', form_id: 'f1' });
  });
});
