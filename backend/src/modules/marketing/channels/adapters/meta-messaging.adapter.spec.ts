const mockFetch = jest.fn();
const mockSub = jest.fn();
jest.mock('../../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: (...a: unknown[]) => mockFetch(...a),
  // The parsing of subscribed_apps is unit-tested where it lives
  // (meta-graph.util.spec.ts). What belongs here is the adapter's DECISION
  // given an answer: fail on a plain "no", never fail on "could not find out".
  metaWebhookSubscription: (...a: unknown[]) => mockSub(...a),
}));

import { MessengerAdapter, InstagramAdapter } from './meta-messaging.adapter';

const reg = () => ({ register: jest.fn() });
const cfg = (secrets: any = { pageAccessToken: 'pat' }, externalId: any = 'page1') =>
  ({ channelId: 'c', workspaceId: 'w', type: 'MESSENGER', externalId, secrets, public: {} }) as any;

beforeEach(() => {
  mockFetch.mockReset();
  mockSub.mockReset();
  mockSub.mockResolvedValue({ subscribed: true, fields: ['messages'] });
});

describe('MessengerAdapter.send', () => {
  it('sends text via /me/messages and returns SENT', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { message_id: 'mid.1' }, error: null });
    const a = new MessengerAdapter(reg() as any);
    const r = await a.send({ config: cfg(), to: 'psid1', text: 'hi' });
    expect(r).toEqual({ externalMessageId: 'mid.1', status: 'SENT' });
    const [path, opts] = mockFetch.mock.calls[0];
    expect(path).toBe('/me/messages');
    expect(opts.body.recipient).toEqual({ id: 'psid1' });
    expect(opts.body.message).toEqual({ text: 'hi' });
  });

  it('sends media as an attachment', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { message_id: 'x' }, error: null });
    const a = new MessengerAdapter(reg() as any);
    await a.send({ config: cfg(), to: 'p', text: '', media: { url: 'http://i', kind: 'image' } });
    expect(mockFetch.mock.calls[0][1].body.message).toEqual({
      attachment: { type: 'image', payload: { url: 'http://i', is_reusable: false } },
    });
  });

  it('returns FAILED on a provider error (never throws)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, data: {}, error: { message: 'nope' } });
    const a = new MessengerAdapter(reg() as any);
    expect((await a.send({ config: cfg(), to: 'p', text: 'hi' })).status).toBe('FAILED');
  });

  it('FAILED without a call when the page token is missing', async () => {
    const a = new MessengerAdapter(reg() as any);
    const r = await a.send({ config: cfg({}, 'page1'), to: 'p', text: 'hi' });
    expect(r.status).toBe('FAILED');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('MessengerAdapter parse + health', () => {
  it('parseInbound returns PSID text messages', () => {
    const a = new MessengerAdapter(reg() as any);
    const inb = a.parseInbound(cfg(), {
      entry: [{ messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', text: 'hey' } }] }],
    });
    expect(inb).toEqual([
      expect.objectContaining({ externalUserId: 'u1', kind: 'PSID', text: 'hey', externalMessageId: 'm1' }),
    ]);
  });

  it('parseInbound extracts the ads referral (click-to-Messenger) attached to a message event', () => {
    const a = new MessengerAdapter(reg() as any);
    const inb = a.parseInbound(cfg(), {
      entry: [
        {
          messaging: [
            {
              sender: { id: 'u1' },
              message: { mid: 'm1', text: 'hey' },
              referral: { ref: 'x', source: 'ADS', type: 'OPEN_THREAD', ad_id: 'ad-77', referer_uri: 'https://fb.com/ad' },
            },
          ],
        },
      ],
    });
    expect(inb[0].referral).toEqual({
      sourceId: 'ad-77',
      ctwaClid: null,
      sourceUrl: 'https://fb.com/ad',
      sourceType: 'ADS',
    });
  });

  it('parseInbound leaves referral undefined for an organic message', () => {
    const a = new MessengerAdapter(reg() as any);
    const inb = a.parseInbound(cfg(), {
      entry: [{ messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', text: 'hey' } }] }],
    });
    expect(inb[0].referral).toBeUndefined();
  });

  it('parseStatusUpdates maps delivery mids to DELIVERED', () => {
    const a = new MessengerAdapter(reg() as any);
    const st = a.parseStatusUpdates(cfg(), { entry: [{ messaging: [{ delivery: { mids: ['m1', 'm2'] } }] }] });
    expect(st).toEqual([
      { externalMessageId: 'm1', status: 'DELIVERED' },
      { externalMessageId: 'm2', status: 'DELIVERED' },
    ]);
  });

  /**
   * A live token and a delivering webhook are INDEPENDENT.
   *
   * Embedded Signup subscribes the app in a separate, best-effort call — a
   * failure there is logged and the channel is created anyway — and nothing
   * afterwards ever looked again. So a channel could hold a perfectly valid
   * token, pass verify, sit ACTIVE, and never receive one inbound message for
   * as long as it existed. That is the business's front door failing without a
   * single error anywhere, which is exactly why healthCheck now asks.
   */
  const okMe = { ok: true, status: 200, data: { id: 'p', name: 'Page' }, error: null };

  it('healthCheck ok:true when the token works AND the page is subscribed', async () => {
    mockFetch.mockResolvedValueOnce(okMe);
    mockSub.mockResolvedValue({ subscribed: true, fields: ['messages', 'message_reads'] });
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    expect(res.ok).toBe(true);
    expect(res.details!.webhookSubscribed).toBe(true);
    // The node comes from /me (the token's own page), not from externalId.
    expect(mockSub).toHaveBeenCalledWith('pat', 'p');
  });

  it('healthCheck ok:false when the token works but nothing is subscribed', async () => {
    mockFetch.mockResolvedValueOnce(okMe);
    mockSub.mockResolvedValue({ subscribed: false, fields: [] });
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    // The old contract said ok:true here — the token IS fine — and that is the
    // answer that let a deaf channel look healthy.
    expect(res.ok).toBe(false);
    expect(res.details!.webhookSubscribed).toBe(false);
  });

  it('does not condemn a working channel when the subscription probe cannot answer', async () => {
    mockFetch.mockResolvedValueOnce(okMe);
    mockSub.mockResolvedValue({ subscribed: null, fields: [], error: 'no permission' });
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    // An unanswered probe is UNKNOWN, not "broken" — surfaced as null rather
    // than silently passing as healthy, and never used to fail the channel.
    expect(res.ok).toBe(true);
    expect(res.details!.webhookSubscribed).toBeNull();
    expect(res.details!.webhookProbeError).toContain('no permission');
  });

  it('healthCheck ok:false without a call when token missing', async () => {
    const a = new MessengerAdapter(reg() as any);
    expect((await a.healthCheck(cfg({}, null))).ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('InstagramAdapter', () => {
  it('parseInbound returns IGSID kind', () => {
    const a = new InstagramAdapter(reg() as any);
    const inb = a.parseInbound(cfg(), {
      entry: [{ messaging: [{ sender: { id: 'ig1' }, message: { mid: 'm', text: 'hi' } }] }],
    });
    expect(inb[0].kind).toBe('IGSID');
  });

  it('self-registers on init', () => {
    const registry = reg();
    const a = new InstagramAdapter(registry as any);
    a.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(a);
  });
});

/**
 * Instagram's channel row stores the IG ACCOUNT id, but `subscribed_apps` only
 * exists on the PAGE the account is attached to — asking the IG node returns
 * "(#100) Tried accessing nonexisting field (subscribed_apps)". Found by
 * running the real probe against the live Instagram channel, which came back
 * inconclusive for exactly that reason while Messenger came back with its
 * field list.
 */
describe("Meta webhook probe targets the token's own node", () => {
  it('asks the page id from /me, not the Instagram account id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { id: 'page-77', name: 'HummyTummy' },
      error: null,
    });
    mockSub.mockResolvedValue({ subscribed: true, fields: ['messages'] });
    const a = new InstagramAdapter(reg() as any);

    const res = await a.healthCheck(cfg({ pageAccessToken: 'pat' }, '17841446386025282'));

    // Instagram's channel row stores the IG ACCOUNT id, but subscribed_apps
    // only exists on the PAGE the account is attached to — asking the IG node
    // returns "(#100) Tried accessing nonexisting field". Found by running the
    // real probe against the live channel.
    expect(mockSub).toHaveBeenCalledWith('pat', 'page-77');
    expect(res.details!.webhookSubscribed).toBe(true);
  });
});

describe('the owner replying from their phone', () => {
  // Meta calls these echoes. They used to be dropped wholesale as "our own
  // sends", which is why a thread could show 25 messages in and none out while
  // every one had been answered from the Instagram app.
  const echoEvent = (over: any = {}) => ({
    entry: [
      {
        messaging: [
          {
            sender: { id: 'PAGE_1' },
            recipient: { id: 'CUSTOMER_9' },
            message: { mid: 'mid.echo1', text: 'Tabii, yarın gönderiyoruz', is_echo: true, ...over },
          },
        ],
      },
    ],
  });

  it('keeps the echo, and files it under the CUSTOMER, not the business', () => {
    // The envelope is inverted on an echo. Taking `sender` would file every
    // outbound message into one conversation with the page itself.
    const a = new MessengerAdapter(reg() as any);
    const [m] = a.parseInbound(cfg(), echoEvent());
    expect(m).toMatchObject({
      externalUserId: 'CUSTOMER_9',
      externalMessageId: 'mid.echo1',
      text: 'Tabii, yarın gönderiyoruz',
      echo: true,
    });
  });

  it('does not mark an ordinary customer message as an echo', () => {
    const a = new MessengerAdapter(reg() as any);
    const [m] = a.parseInbound(cfg(), {
      entry: [{ messaging: [{ sender: { id: 'CUSTOMER_9' }, message: { mid: 'm1', text: 'merhaba' } }] }],
    });
    expect(m.externalUserId).toBe('CUSTOMER_9');
    expect(m.echo).toBeUndefined();
  });

  it('still ignores a non-text echo — receipts belong to parseStatusUpdates', () => {
    const a = new MessengerAdapter(reg() as any);
    expect(a.parseInbound(cfg(), echoEvent({ text: undefined }))).toEqual([]);
  });

  it('drops an echo with no recipient rather than inventing a thread', () => {
    const a = new MessengerAdapter(reg() as any);
    const body = echoEvent();
    delete (body.entry[0].messaging[0] as any).recipient;
    expect(a.parseInbound(cfg(), body)).toEqual([]);
  });

  it('reads Instagram echoes the same way', () => {
    const a = new InstagramAdapter(reg() as any);
    const [m] = a.parseInbound(cfg(), echoEvent());
    expect(m).toMatchObject({ externalUserId: 'CUSTOMER_9', kind: 'IGSID', echo: true });
  });

  describe('health check', () => {
    it('warns when the Page never subscribed to echoes — Meta does not backfill', async () => {
      mockFetch.mockResolvedValue({ ok: true, data: { id: 'page1', name: 'Acme' } });
      mockSub.mockResolvedValue({ subscribed: true, fields: ['messages', 'leadgen'] });
      const r: any = await new MessengerAdapter(reg() as any).healthCheck(cfg());
      expect(r.ok).toBe(true); // still healthy — it hears customers
      expect(r.details.echoesSubscribed).toBe(false);
      expect(r.details.warning).toMatch(/message_echoes/);
    });

    it('says nothing when echoes ARE subscribed', async () => {
      mockFetch.mockResolvedValue({ ok: true, data: { id: 'page1', name: 'Acme' } });
      mockSub.mockResolvedValue({ subscribed: true, fields: ['messages', 'message_echoes'] });
      const r: any = await new MessengerAdapter(reg() as any).healthCheck(cfg());
      expect(r.details.echoesSubscribed).toBeUndefined();
      expect(r.details.warning).toBeUndefined();
    });

    it('does not claim a missing field when the probe could not answer', async () => {
      // An unanswerable probe is unknown, not "not subscribed" — reporting a
      // gap here would send someone to reconnect a channel that is fine.
      mockFetch.mockResolvedValue({ ok: true, data: { id: 'page1', name: 'Acme' } });
      mockSub.mockResolvedValue({ subscribed: null, fields: null, error: 'probe failed' });
      const r: any = await new MessengerAdapter(reg() as any).healthCheck(cfg());
      expect(r.details.echoesSubscribed).toBeUndefined();
      expect(r.details.warning).toBeUndefined();
    });
  });
});
