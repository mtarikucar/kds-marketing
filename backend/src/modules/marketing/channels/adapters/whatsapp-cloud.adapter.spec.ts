const mockFetch = jest.fn();
const mockSub = jest.fn();
jest.mock('../../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: (...a: unknown[]) => mockFetch(...a),
  metaWebhookSubscription: (...a: unknown[]) => mockSub(...a),
}));

import { WhatsappCloudAdapter } from './whatsapp-cloud.adapter';

function adapter() {
  const registry = { register: jest.fn() };
  return { a: new WhatsappCloudAdapter(registry as any), registry };
}
const cfg = (secrets: any = { accessToken: 'tok', phoneNumberId: 'PN' }, externalId: any = 'PN') =>
  ({ channelId: 'c', workspaceId: 'w', type: 'WHATSAPP', externalId, secrets, public: {} }) as any;

beforeEach(() => {
  mockFetch.mockReset();
  mockSub.mockReset();
});

describe('WhatsappCloudAdapter.send', () => {
  it('sends text and returns SENT with the wamid (Bearer auth, /PN/messages)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { messages: [{ id: 'wamid.1' }] }, error: null });
    const { a } = adapter();
    const r = await a.send({ config: cfg(), to: '+90555', text: 'hi' });
    expect(r).toEqual({ externalMessageId: 'wamid.1', status: 'SENT' });
    const [path, opts] = mockFetch.mock.calls[0];
    expect(path).toBe('/PN/messages');
    expect(opts.bearer).toBe(true);
    expect(opts.body).toMatchObject({ type: 'text', text: { body: 'hi' }, to: '+90555' });
  });

  it('builds a template body', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { messages: [{ id: 'x' }] }, error: null });
    const { a } = adapter();
    await a.send({ config: cfg(), to: 't', text: '', template: { name: 'hello', languageCode: 'tr' } });
    expect(mockFetch.mock.calls[0][1].body).toMatchObject({
      type: 'template',
      template: { name: 'hello', language: { code: 'tr' } },
    });
  });

  it('builds an image media body', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { messages: [{ id: 'x' }] }, error: null });
    const { a } = adapter();
    await a.send({ config: cfg(), to: 't', text: '', media: { url: 'http://img', kind: 'image', caption: 'c' } });
    expect(mockFetch.mock.calls[0][1].body).toMatchObject({
      type: 'image',
      image: { link: 'http://img', caption: 'c' },
    });
  });

  it('returns FAILED on a provider error (never throws)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, data: {}, error: { message: 'bad token', isAuthError: true } });
    const { a } = adapter();
    const r = await a.send({ config: cfg(), to: 't', text: 'hi' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toContain('WA 401');
  });

  it('FAILED without a live call when secrets are missing', async () => {
    const { a } = adapter();
    const r = await a.send({ config: cfg({}, null), to: 't', text: 'hi' });
    expect(r.status).toBe('FAILED');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('WhatsappCloudAdapter.parseInbound', () => {
  const msg = (extra: any = {}) => ({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '90555', profile: { name: 'Ayşe' } }],
              messages: [{ from: '90555', id: 'wamid.1', text: { body: 'merhaba' }, ...extra }],
            },
          },
        ],
      },
    ],
  });

  it('parses a plain text message (no referral field)', () => {
    const { a } = adapter();
    const inb = a.parseInbound(cfg(), msg());
    expect(inb).toHaveLength(1);
    expect(inb[0]).toMatchObject({ externalUserId: '90555', kind: 'WA', externalMessageId: 'wamid.1', text: 'merhaba' });
    expect(inb[0].referral).toBeUndefined();
  });

  it('extracts the CTWA referral (ctwa_clid + source_id + source_url) when the ad click carried one', () => {
    const { a } = adapter();
    const inb = a.parseInbound(
      cfg(),
      msg({
        referral: {
          source_url: 'https://fb.me/xyz?utm_campaign=c1',
          source_type: 'ad',
          source_id: '1201234567890',
          ctwa_clid: 'CTWA-CLICK-1',
          headline: 'Buy now',
        },
      }),
    );
    expect(inb[0].referral).toEqual({
      sourceId: '1201234567890',
      ctwaClid: 'CTWA-CLICK-1',
      sourceUrl: 'https://fb.me/xyz?utm_campaign=c1',
      sourceType: 'ad',
    });
  });

  it('ignores a referral object that carries neither a source id nor a ctwa_clid', () => {
    const { a } = adapter();
    const inb = a.parseInbound(cfg(), msg({ referral: { headline: 'x' } }));
    expect(inb[0].referral).toBeUndefined();
  });
});

describe('WhatsappCloudAdapter.parseStatusUpdates', () => {
  it('maps WA statuses to StatusUpdate[]', () => {
    const { a } = adapter();
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'read' }] } }] }] };
    expect(a.parseStatusUpdates(cfg(), body)).toEqual([{ externalMessageId: 'wamid.1', status: 'READ' }]);
  });
});

describe('WhatsappCloudAdapter.healthCheck', () => {
  const okNumber = (extra: Record<string, unknown> = {}) => ({
    ok: true,
    status: 200,
    data: { verified_name: 'Acme', ...extra },
    error: null,
  });
  const debugToken = (targets: string[], scope = 'whatsapp_business_messaging') => ({
    ok: true,
    status: 200,
    data: { data: { granular_scopes: [{ scope, target_ids: targets }] } },
    error: null,
  });

  it('ok:true on a 200 probe (returns verified_name)', async () => {
    mockFetch.mockResolvedValue(okNumber());
    mockSub.mockResolvedValue({ subscribed: true, fields: ['messages'] });
    const { a } = adapter();
    const h = await a.healthCheck(cfg());
    expect(h.ok).toBe(true);
    expect(h.details?.verifiedName).toBe('Acme');
  });

  /**
   * On WhatsApp the gap between "token works" and "messages arrive" is wider
   * than anywhere else: the subscription lives on the WABA, and the channel
   * stores only phoneNumberId — so the WABA id is nowhere in our data and has to
   * be resolved from the number before the question can even be asked.
   */
  it('resolves the WABA from the TOKEN, then asks whether it is subscribed', async () => {
    process.env.META_APP_ID = 'app1';
    process.env.META_APP_SECRET = 'sec';
    mockFetch.mockResolvedValueOnce(okNumber()).mockResolvedValueOnce(debugToken(['WABA1']));
    mockSub.mockResolvedValue({ subscribed: true, fields: ['messages'] });
    const { a } = adapter();

    const h = await a.healthCheck(cfg());

    // The phone-number node does not carry its WABA — asking it for
    // `whatsapp_business_account` returns "(#100) nonexisting field", which is
    // how the first attempt failed against the live channel. The token does
    // carry it, as granular_scopes.
    expect(mockFetch.mock.calls[1][0]).toBe('/debug_token');
    expect(mockFetch.mock.calls[1][1].query.input_token).toBe('tok');
    // Both tokens go in the query so the client does not attach an
    // appsecret_proof computed from the APP token.
    expect(mockFetch.mock.calls[1][1].accessToken).toBeUndefined();
    expect(mockSub).toHaveBeenCalledWith('tok', 'WABA1', { bearer: true });
    expect(h.details?.wabaId).toBe('WABA1');
    expect(h.details?.webhookSubscribed).toBe(true);
  });

  it('ok:false when the WABA is resolved and plainly not subscribed', async () => {
    process.env.META_APP_ID = 'app1';
    process.env.META_APP_SECRET = 'sec';
    mockFetch.mockResolvedValueOnce(okNumber()).mockResolvedValueOnce(debugToken(['WABA1']));
    mockSub.mockResolvedValue({ subscribed: false, fields: [] });
    const { a } = adapter();

    const h = await a.healthCheck(cfg());

    // A number that cannot receive is not healthy, however good its token.
    expect(h.ok).toBe(false);
    expect(h.details?.webhookSubscribed).toBe(false);
  });

  it('says unknown rather than guessing when the token covers several accounts', async () => {
    process.env.META_APP_ID = 'app1';
    process.env.META_APP_SECRET = 'sec';
    mockFetch.mockResolvedValueOnce(okNumber()).mockResolvedValueOnce(debugToken(['WABA1', 'WABA2']));
    const { a } = adapter();

    const h = await a.healthCheck(cfg());

    // Picking one would put a confident wrong answer where an honest unknown
    // belongs — the exact failure the three-valued probe exists to prevent.
    expect(h.ok).toBe(true);
    expect(h.details?.webhookSubscribed).toBeNull();
    expect(String(h.details?.webhookProbeError)).toContain('2 WhatsApp accounts');
    expect(mockSub).not.toHaveBeenCalled();
  });

  it('stays ok with webhookSubscribed:null when the token grants no WABA', async () => {
    process.env.META_APP_ID = 'app1';
    process.env.META_APP_SECRET = 'sec';
    mockFetch.mockResolvedValueOnce(okNumber()).mockResolvedValueOnce(debugToken([], 'pages_show_list'));
    const { a } = adapter();

    const h = await a.healthCheck(cfg());

    expect(h.ok).toBe(true);
    expect(h.details?.webhookSubscribed).toBeNull();
    expect(mockSub).not.toHaveBeenCalled();
  });

  it('does not even try the lookup when the platform has no app credentials', async () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    mockFetch.mockResolvedValueOnce(okNumber());
    const { a } = adapter();

    const h = await a.healthCheck(cfg());

    expect(h.ok).toBe(true);
    expect(h.details?.webhookSubscribed).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('ok:false on a revoked token (401), never throws', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, data: {}, error: { message: 'bad', isAuthError: true } });
    const { a } = adapter();
    expect((await a.healthCheck(cfg())).ok).toBe(false);
  });

  it('ok:false WITHOUT a call when a secret is missing', async () => {
    const { a } = adapter();
    expect((await a.healthCheck(cfg({}, null))).ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('WhatsappCloudAdapter.onModuleInit', () => {
  it('self-registers into the registry', () => {
    const { a, registry } = adapter();
    a.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(a);
  });
});
