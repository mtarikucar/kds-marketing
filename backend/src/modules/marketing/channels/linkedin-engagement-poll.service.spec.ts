import { LinkedinEngagementPollService } from './linkedin-engagement-poll.service';
import * as linkedinApi from '../../../common/util/linkedin-api.util';

jest.mock('../../../common/util/linkedin-api.util');

/**
 * Polls comments on the workspace's OWN LinkedIn org posts (there is no webhook)
 * and routes third-party comments through conversation ingress as inbound
 * messages. Self-authored replies (actor === channel actor urn) are skipped to
 * avoid a reply loop; ingest()'s externalMessageId dedup makes re-polling safe.
 * Fully no-ops when the channel's capability flag is not granted.
 */
describe('LinkedinEngagementPollService.poll', () => {
  let prisma: any;
  let registry: any;
  let ingress: any;
  let service: LinkedinEngagementPollService;
  const linkedinRest = linkedinApi.linkedinRest as jest.Mock;

  const liChannel = {
    id: 'ch-li',
    workspaceId: 'w1',
    type: 'LINKEDIN',
    status: 'ACTIVE',
    externalId: 'urn:li:organization:123',
    configSealed: 'sealed',
    configPublic: { linkedinEngagement: 'granted' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      workspace: { findMany: jest.fn().mockResolvedValue([{ id: 'w1' }]) },
      channel: { findMany: jest.fn().mockResolvedValue([liChannel]) },
      socialPostTarget: {
        findMany: jest.fn().mockResolvedValue([
          { externalPostId: 'urn:li:ugcPost:999' },
        ]),
      },
    };
    registry = {
      resolveConfig: jest.fn().mockReturnValue({
        channelId: 'ch-li',
        workspaceId: 'w1',
        type: 'LINKEDIN',
        externalId: 'urn:li:organization:123',
        secrets: { accessToken: 'tok' },
        public: { linkedinEngagement: 'granted' },
      }),
    };
    ingress = { ingest: jest.fn().mockResolvedValue({ deduped: false }) };
    service = new LinkedinEngagementPollService(prisma, registry, ingress);
  });

  it('ingests a third-party comment once as an InboundMessage tagged LINKEDIN', async () => {
    linkedinRest.mockResolvedValue({
      ok: true, status: 200, restliId: null, error: null,
      data: { elements: [
        { actor: 'urn:li:person:viewer-7', id: '888', message: { text: 'Great post!' }, object: 'urn:li:ugcPost:999', created: { time: 1 } },
      ] },
    });
    await service.poll();
    expect(ingress.ingest).toHaveBeenCalledTimes(1);
    const [chan, inbound] = ingress.ingest.mock.calls[0];
    expect(chan).toMatchObject({ id: 'ch-li', workspaceId: 'w1', type: 'LINKEDIN' });
    expect(inbound).toMatchObject({
      externalUserId: 'urn:li:person:viewer-7',
      kind: 'LINKEDIN',
      externalMessageId: '888',
      text: 'Great post!',
    });
  });

  it('skips a self-authored comment (actor === channel actor urn) — no reply loop', async () => {
    linkedinRest.mockResolvedValue({
      ok: true, status: 200, restliId: null, error: null,
      data: { elements: [
        { actor: 'urn:li:organization:123', id: '999', message: { text: 'our own reply' }, object: 'urn:li:ugcPost:999' },
      ] },
    });
    await service.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('no-ops entirely when the capability flag is not granted', async () => {
    prisma.channel.findMany.mockResolvedValue([
      { ...liChannel, configPublic: {} },
    ]);
    await service.poll();
    expect(prisma.socialPostTarget.findMany).not.toHaveBeenCalled();
    expect(linkedinRest).not.toHaveBeenCalled();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('scopes the channel + post queries by workspaceId', async () => {
    linkedinRest.mockResolvedValue({ ok: true, status: 200, restliId: null, error: null, data: { elements: [] } });
    await service.poll();
    expect(prisma.channel.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ workspaceId: 'w1', type: 'LINKEDIN', status: 'ACTIVE' }),
    );
    expect(prisma.socialPostTarget.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ workspaceId: 'w1', network: 'LINKEDIN' }),
    );
  });

  it('does not query posts when there is no granted LINKEDIN channel', async () => {
    prisma.channel.findMany.mockResolvedValue([]);
    await service.poll();
    expect(prisma.socialPostTarget.findMany).not.toHaveBeenCalled();
    expect(linkedinRest).not.toHaveBeenCalled();
  });
});
