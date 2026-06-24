import { LinkedinEngagementAdapter } from './linkedin-engagement.adapter';
import * as linkedinApi from '../../../../common/util/linkedin-api.util';

jest.mock('../../../../common/util/linkedin-api.util');

describe('LinkedinEngagementAdapter', () => {
  const registry = { register: jest.fn() } as any;
  let adapter: LinkedinEngagementAdapter;
  const linkedinRest = linkedinApi.linkedinRest as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LinkedinEngagementAdapter(registry);
  });

  const grantedConfig = (over: any = {}) => ({
    channelId: 'ch-li',
    workspaceId: 'w1',
    type: 'LINKEDIN',
    externalId: 'urn:li:organization:123',
    secrets: { accessToken: 'tok' },
    public: { linkedinEngagement: 'granted' },
    ...over,
  });

  it('registers itself on module init as LINKEDIN', () => {
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);
    expect(adapter.type).toBe('LINKEDIN');
  });

  it('is INERT (FAILED, no HTTP) when the capability flag is not granted', async () => {
    const res = await adapter.send({
      config: grantedConfig({ public: {} }) as any,
      to: 'urn:li:ugcPost:999',
      text: 'hi',
    });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('not granted');
    expect(linkedinRest).not.toHaveBeenCalled();
  });

  it('posts a comment REPLY with actor/object/message body to the post urn from `to`', async () => {
    linkedinRest.mockResolvedValue({ ok: true, status: 201, data: {}, restliId: 'urn:li:comment:(urn:li:ugcPost:999,888)', error: null });
    const res = await adapter.send({
      config: grantedConfig() as any,
      to: 'urn:li:ugcPost:999',
      text: 'Thanks for the comment!',
    });
    expect(linkedinRest).toHaveBeenCalledWith(
      '/rest/socialActions/urn%3Ali%3AugcPost%3A999/comments',
      expect.objectContaining({
        accessToken: 'tok',
        method: 'POST',
        body: {
          actor: 'urn:li:organization:123',
          object: 'urn:li:ugcPost:999',
          message: { text: 'Thanks for the comment!' },
        },
      }),
    );
    expect(res).toEqual({ externalMessageId: 'urn:li:comment:(urn:li:ugcPost:999,888)', status: 'SENT' });
  });

  it('maps a linkedinRest !ok into FAILED with the provider error message', async () => {
    linkedinRest.mockResolvedValue({ ok: false, status: 403, data: null, restliId: null, error: { message: 'ACCESS_DENIED', status: 403, serviceErrorCode: null, isAuthError: false, raw: {} } });
    const res = await adapter.send({ config: grantedConfig() as any, to: 'urn:li:ugcPost:999', text: 'hi' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('ACCESS_DENIED');
    expect(res.externalMessageId).toBeNull();
  });

  it('falls back to config.public.postUrn when `to` is empty', async () => {
    linkedinRest.mockResolvedValue({ ok: true, status: 201, data: {}, restliId: 'urn:li:comment:x', error: null });
    await adapter.send({
      config: grantedConfig({ public: { linkedinEngagement: 'granted', postUrn: 'urn:li:ugcPost:777' } }) as any,
      to: '',
      text: 'hi',
    });
    expect(linkedinRest).toHaveBeenCalledWith(
      '/rest/socialActions/urn%3Ali%3AugcPost%3A777/comments',
      expect.objectContaining({ body: expect.objectContaining({ object: 'urn:li:ugcPost:777' }) }),
    );
  });

  it('healthCheck is true only with an access token AND an externalId (actor urn)', async () => {
    expect((await adapter.healthCheck({ secrets: {}, externalId: 'urn:li:organization:123' } as any)).ok).toBe(false);
    expect((await adapter.healthCheck({ secrets: { accessToken: 't' }, externalId: null } as any)).ok).toBe(false);
    expect((await adapter.healthCheck({ secrets: { accessToken: 't' }, externalId: 'urn:li:organization:123' } as any)).ok).toBe(true);
  });
});
