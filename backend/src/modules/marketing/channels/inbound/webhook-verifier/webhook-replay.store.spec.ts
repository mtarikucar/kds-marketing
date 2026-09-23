import { WebhookReplayStore } from './webhook-replay.store';
import { SIGNATURE_MAX_AGE_MS } from './index';

/**
 * The in-process half, which is what runs wherever REDIS_URL is unset (dev, the
 * e2e harness, a single-replica box). The Redis half is the same two calls
 * behind a client, and falls back to exactly this on any error.
 */
describe('WebhookReplayStore (in-process)', () => {
  const realUrl = process.env.REDIS_URL;
  let store: WebhookReplayStore;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    store = new WebhookReplayStore();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (realUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = realUrl;
  });

  const hashA = WebhookReplayStore.hashBody(Buffer.from('{"a":1}'));
  const hashB = WebhookReplayStore.hashBody(Buffer.from('{"a":2}'));

  it('has never seen a token it was not told about', async () => {
    expect(await store.check('mailgun', 'tok', hashA)).toEqual({ seen: false });
  });

  it('tells a redelivery of the same bytes apart from a forgery', async () => {
    await store.remember('mailgun', 'tok', hashA);
    expect(await store.check('mailgun', 'tok', hashA)).toEqual({ seen: true, sameBody: true });
    expect(await store.check('mailgun', 'tok', hashB)).toEqual({ seen: true, sameBody: false });
  });

  it('keeps each provider’s token space to itself', async () => {
    await store.remember('mailgun', 'tok', hashA);
    expect(await store.check('postmark', 'tok', hashA)).toEqual({ seen: false });
  });

  it('forgets a token once its signature could no longer be fresh anyway', async () => {
    await store.remember('mailgun', 'tok', hashA);
    const then = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(then + SIGNATURE_MAX_AGE_MS + 1000);
    expect(await store.check('mailgun', 'tok', hashA)).toEqual({ seen: false });
  });

  it('ignores an empty token rather than sharing one slot between every caller', async () => {
    await store.remember('mailgun', '', hashA);
    expect(await store.check('mailgun', '', hashA)).toEqual({ seen: false });
  });

  it('hashes the exact bytes, so one changed character is a different body', () => {
    expect(WebhookReplayStore.hashBody(Buffer.from('{"a":1}'))).toBe(hashA);
    expect(hashA).not.toBe(hashB);
  });
});
