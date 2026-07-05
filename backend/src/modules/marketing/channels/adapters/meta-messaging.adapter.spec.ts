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

  it('healthCheck ok:true on a 200 /me probe', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: { id: 'p', name: 'Page' }, error: null });
    const a = new MessengerAdapter(reg() as any);
    expect((await a.healthCheck(cfg())).ok).toBe(true);
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
