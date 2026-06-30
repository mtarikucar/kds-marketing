import { createHmac } from 'crypto';
import { TiktokWebhookController } from './tiktok-webhook.controller';

/**
 * The TikTok DM webhook's trust boundary is the HMAC-SHA256 over the RAW body
 * (header: tiktok-signature or x-tiktok-signature) + the GET challenge.  These
 * guard against spoofed inbound events, so they get a focused spec.  Mirrors
 * meta-webhook.controller.spec.ts for mocking patterns.
 */
describe('TiktokWebhookController — signature + challenge', () => {
  const SECRET = 'test-webhook-secret';
  const VERIFY_TOKEN = 'test-verify-token';

  /** Stub deps — real routing is an integration concern. */
  function makeController(overrides: {
    byExternalId?: jest.Mock;
    parseInbound?: jest.Mock;
    ingest?: jest.Mock;
  } = {}) {
    const resolver = {
      byExternalId: overrides.byExternalId ?? jest.fn().mockResolvedValue(null),
    };
    const adapter = {
      parseInbound: overrides.parseInbound ?? jest.fn().mockReturnValue([]),
    };
    const registry = {
      has: jest.fn().mockReturnValue(true),
      get: jest.fn().mockReturnValue(adapter),
      resolveConfig: jest.fn().mockReturnValue({}),
    };
    const ingress = {
      ingest: overrides.ingest ?? jest.fn().mockResolvedValue(undefined),
    };
    return new TiktokWebhookController(resolver as any, registry as any, ingress as any);
  }

  function sign(raw: Buffer): string {
    return createHmac('sha256', SECRET).update(raw).digest('hex');
  }

  beforeEach(() => {
    process.env.TIKTOK_WEBHOOK_SECRET = SECRET;
    process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  });

  afterEach(() => {
    delete process.env.TIKTOK_WEBHOOK_SECRET;
    delete process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN;
    jest.restoreAllMocks();
  });

  // ── validSignature (private) ───────────────────────────────────────────────

  it('accepts a correct bare-hex signature', () => {
    const ctrl = makeController();
    const raw = Buffer.from(JSON.stringify({ event_type: 'message', business_id: 'biz1' }));
    expect((ctrl as any).validSignature(raw, sign(raw))).toBe(true);
  });

  it('accepts the "t=…,s=<hex>" compound format', () => {
    const ctrl = makeController();
    const raw = Buffer.from('{"event_type":"ping"}');
    const compound = `t=1234567890,s=${sign(raw)}`;
    expect((ctrl as any).validSignature(raw, compound)).toBe(true);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const ctrl = makeController();
    const raw = Buffer.from('{"event_type":"message"}');
    const goodSig = sign(raw);
    const tampered = Buffer.from('{"event_type":"EVIL"}');
    expect((ctrl as any).validSignature(tampered, goodSig)).toBe(false);
  });

  it('rejects an undefined/missing signature header', () => {
    const ctrl = makeController();
    expect((ctrl as any).validSignature(Buffer.from('{}'), undefined)).toBe(false);
  });

  it('rejects when TIKTOK_WEBHOOK_SECRET is not configured', () => {
    delete process.env.TIKTOK_WEBHOOK_SECRET;
    const ctrl = makeController();
    const raw = Buffer.from('{}');
    expect((ctrl as any).validSignature(raw, sign(raw))).toBe(false);
  });

  // ── POST /webhook — receive() ──────────────────────────────────────────────

  it('valid signature → 200 ACK "EVENT_RECEIVED" and triggers processing', async () => {
    const ingest = jest.fn().mockResolvedValue(undefined);
    const parseInbound = jest.fn().mockReturnValue([{ text: 'hello', from: 'user1' }]);
    const channel = { id: 'ch-1', workspaceId: 'ws-1', type: 'TIKTOK' };
    const byExternalId = jest.fn().mockResolvedValue(channel);

    const ctrl = makeController({ byExternalId, parseInbound, ingest });

    const body = { event_type: 'message', business_id: 'biz42', data: { text: 'hello' } };
    const raw = Buffer.from(JSON.stringify(body));
    const req: any = {
      body: raw,
      headers: { 'tiktok-signature': sign(raw) },
    };
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    ctrl.receive(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('EVENT_RECEIVED');

    // Allow the async process() to settle
    await new Promise((r) => setImmediate(r));

    expect(byExternalId).toHaveBeenCalledWith('TIKTOK', 'biz42');
    expect(ingest).toHaveBeenCalledWith(
      { id: 'ch-1', workspaceId: 'ws-1', type: 'TIKTOK' },
      { text: 'hello', from: 'user1' },
    );
  });

  it('valid signature also accepted via x-tiktok-signature header', () => {
    const ctrl = makeController();
    const raw = Buffer.from('{"business_id":"b1"}');
    const req: any = {
      body: raw,
      headers: { 'x-tiktok-signature': sign(raw) },
    };
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    ctrl.receive(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('bad signature → 401 and no processing', async () => {
    const ingest = jest.fn();
    const ctrl = makeController({ ingest });
    const raw = Buffer.from('{"business_id":"biz1"}');
    const req: any = {
      body: raw,
      headers: { 'tiktok-signature': 'bad-signature-value' },
    };
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    ctrl.receive(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith('bad signature');

    await new Promise((r) => setImmediate(r));
    expect(ingest).not.toHaveBeenCalled();
  });

  it('missing signature header → 401', () => {
    const ctrl = makeController();
    const raw = Buffer.from('{}');
    const req: any = { body: raw, headers: {} };
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    ctrl.receive(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // ── GET /webhook — verify() challenge ─────────────────────────────────────

  it('GET: echoes challenge when verify_token matches', () => {
    const ctrl = makeController();
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    ctrl.verify({ verify_token: VERIFY_TOKEN, challenge: 'abc123' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('abc123');
  });

  it('GET: 403 when verify_token is wrong', () => {
    const ctrl = makeController();
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    ctrl.verify({ verify_token: 'WRONG', challenge: 'abc123' }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('GET: 403 when challenge is absent', () => {
    const ctrl = makeController();
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    ctrl.verify({ verify_token: VERIFY_TOKEN }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
