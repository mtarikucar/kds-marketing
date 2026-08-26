const mockFetch = jest.fn();
jest.mock('../../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: (...a: unknown[]) => mockFetch(...a),
}));

import { MessengerAdapter, InstagramAdapter } from './meta-messaging.adapter';

const reg = () => ({ register: jest.fn() });
const cfg = (secrets: any = { pageAccessToken: 'pat' }, externalId: any = 'page1') =>
  ({ channelId: 'c', workspaceId: 'w', type: 'MESSENGER', externalId, secrets, public: {} }) as any;

beforeEach(() => mockFetch.mockReset());

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
  const subs = (apps: unknown[]) => ({ ok: true, status: 200, data: { data: apps }, error: null });

  it('healthCheck ok:true when the token works AND the page is subscribed', async () => {
    process.env.META_APP_ID = 'app1';
    mockFetch
      .mockResolvedValueOnce(okMe)
      .mockResolvedValueOnce(subs([{ id: 'app1', subscribed_fields: ['messages', 'messaging_postbacks'] }]));
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    expect(res.ok).toBe(true);
    expect(res.details!.webhookSubscribed).toBe(true);
    // The node comes from /me (the token's own page), not from externalId.
    expect(mockFetch.mock.calls[1][0]).toBe('/p/subscribed_apps');
  });

  it('healthCheck ok:false when the token works but nothing is subscribed', async () => {
    process.env.META_APP_ID = 'app1';
    mockFetch.mockResolvedValueOnce(okMe).mockResolvedValueOnce(subs([]));
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    // The old contract said ok:true here — the token IS fine — and that is the
    // answer that let a deaf channel look healthy.
    expect(res.ok).toBe(false);
    expect(res.details!.webhookSubscribed).toBe(false);
  });

  it('healthCheck ok:false when another app is subscribed but ours is not', async () => {
    process.env.META_APP_ID = 'app1';
    mockFetch
      .mockResolvedValueOnce(okMe)
      .mockResolvedValueOnce(subs([{ id: 'someone-else', subscribed_fields: ['messages'] }]));
    const a = new MessengerAdapter(reg() as any);

    expect((await a.healthCheck(cfg())).ok).toBe(false);
  });

  it('healthCheck ok:false when our app is subscribed to other fields but not messages', async () => {
    process.env.META_APP_ID = 'app1';
    mockFetch
      .mockResolvedValueOnce(okMe)
      .mockResolvedValueOnce(subs([{ id: 'app1', subscribed_fields: ['feed', 'mention'] }]));
    const a = new MessengerAdapter(reg() as any);

    // Subscribed to the Page, deaf to messages. Same outcome for the customer.
    expect((await a.healthCheck(cfg())).ok).toBe(false);
  });

  it('does not condemn a working channel when the subscription probe cannot answer', async () => {
    process.env.META_APP_ID = 'app1';
    mockFetch
      .mockResolvedValueOnce(okMe)
      .mockResolvedValueOnce({ ok: false, status: 403, data: null, error: { message: 'no permission' } });
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    // An unanswered probe is UNKNOWN, not "broken" — surfaced as null rather
    // than silently passing as healthy, and never used to fail the channel.
    expect(res.ok).toBe(true);
    expect(res.details!.webhookSubscribed).toBeNull();
    expect(res.details!.webhookProbeError).toContain('no permission');
  });

  it('without META_APP_ID, answers only whether ANYTHING listens for messages', async () => {
    delete process.env.META_APP_ID;
    mockFetch
      .mockResolvedValueOnce(okMe)
      .mockResolvedValueOnce(subs([{ id: 'whoever', subscribed_fields: ['messages'] }]));
    const a = new MessengerAdapter(reg() as any);

    const res = await a.healthCheck(cfg());

    expect(res.ok).toBe(true);
    expect(res.details!.webhookSubscribed).toBe(true);
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
    process.env.META_APP_ID = 'app1';
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, data: { id: 'page-77', name: 'HummyTummy' }, error: null })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ id: 'app1', subscribed_fields: ['messages'] }] },
        error: null,
      });
    const a = new InstagramAdapter(reg() as any);

    const res = await a.healthCheck(
      cfg({ pageAccessToken: 'pat' }, '17841446386025282'),
    );

    expect(mockFetch.mock.calls[1][0]).toBe('/page-77/subscribed_apps');
    expect(res.details!.webhookSubscribed).toBe(true);
  });
});
