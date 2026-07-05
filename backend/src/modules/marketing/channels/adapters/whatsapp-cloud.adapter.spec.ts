const mockFetch = jest.fn();
jest.mock('../../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: (...a: unknown[]) => mockFetch(...a),
}));

import { WhatsappCloudAdapter } from './whatsapp-cloud.adapter';

function adapter() {
  const registry = { register: jest.fn() };
  return { a: new WhatsappCloudAdapter(registry as any), registry };
}
const cfg = (secrets: any = { accessToken: 'tok', phoneNumberId: 'PN' }, externalId: any = 'PN') =>
  ({ channelId: 'c', workspaceId: 'w', type: 'WHATSAPP', externalId, secrets, public: {} }) as any;

beforeEach(() => mockFetch.mockReset());

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
  it('ok:true on a 200 probe (returns verified_name)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { verified_name: 'Acme' }, error: null });
    const { a } = adapter();
    const h = await a.healthCheck(cfg());
    expect(h.ok).toBe(true);
    expect(h.details?.verifiedName).toBe('Acme');
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
