import { resolveAttributionRefs } from './ad-campaign-resolver';
import { parseAttribution } from './attribution-capture.util';

/**
 * D10a/D10c deterministic click→campaign resolution. sourceAdCampaignId comes
 * from our OWN jg_cid param directly, or from a utm_campaign that EXACTLY
 * matches a workspace AdMetric.campaignId (one indexed lookup). Social organic:
 * utm_source=social + jg_pid → sourceSocialPostId. Best-effort only — no fuzzy
 * matching, no provider API calls, and bare click-ids stay stored-but-unresolved.
 */
describe('resolveAttributionRefs', () => {
  const WS = 'ws-1';

  function db(hit: { campaignId: string } | null = null) {
    return { adMetric: { findFirst: jest.fn().mockResolvedValue(hit) } };
  }

  it('trusts an explicit jg_cid param (our own decorated link) with NO lookup', async () => {
    const d = db();
    const input = { url: 'https://x.co/lp?jg_cid=camp-42' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {});
    expect(refs).toEqual({ sourceAdCampaignId: 'camp-42' });
    expect(d.adMetric.findFirst).not.toHaveBeenCalled();
  });

  it('resolves utm_campaign only when it EXACTLY matches a workspace AdMetric.campaignId (one indexed lookup)', async () => {
    const d = db({ campaignId: 'meta-c-9' });
    const input = { url: 'https://x.co/lp?utm_source=facebook&utm_campaign=meta-c-9' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {});
    expect(refs).toEqual({ sourceAdCampaignId: 'meta-c-9' });
    expect(d.adMetric.findFirst).toHaveBeenCalledTimes(1);
    expect(d.adMetric.findFirst.mock.calls[0][0]).toEqual({
      where: { workspaceId: WS, campaignId: 'meta-c-9' },
      select: { campaignId: true },
    });
  });

  it('leaves a non-matching utm_campaign unresolved (deterministic only, no fuzzy)', async () => {
    const d = db(null);
    const input = { url: 'https://x.co/lp?utm_campaign=summer-sale' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {});
    expect(refs).toEqual({});
  });

  it('jg_cid wins over utm_campaign (no lookup spent on the utm)', async () => {
    const d = db({ campaignId: 'other' });
    const input = { url: 'https://x.co/lp?jg_cid=camp-1&utm_campaign=other' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {});
    expect(refs).toEqual({ sourceAdCampaignId: 'camp-1' });
    expect(d.adMetric.findFirst).not.toHaveBeenCalled();
  });

  it('skips the campaign resolution when the caller already supplied sourceAdCampaignId', async () => {
    const d = db({ campaignId: 'c' });
    const input = { url: 'https://x.co/lp?jg_cid=camp-1&utm_campaign=c' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {
      sourceAdCampaignId: 'caller-knows-best',
    });
    expect(refs).toEqual({});
    expect(d.adMetric.findFirst).not.toHaveBeenCalled();
  });

  it('D10c: utm_source=social + jg_pid → sourceSocialPostId', async () => {
    const d = db();
    const input = { url: 'https://x.co/lp?utm_source=social&jg_pid=post-7' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {});
    expect(refs).toEqual({ sourceSocialPostId: 'post-7' });
  });

  it('does NOT resolve jg_pid without utm_source=social (and not for an already-known post)', async () => {
    const d = db();
    const noSocial = { url: 'https://x.co/lp?utm_source=newsletter&jg_pid=post-7' };
    expect(await resolveAttributionRefs(d, WS, noSocial, parseAttribution(noSocial), {})).toEqual({});
    const known = { url: 'https://x.co/lp?utm_source=social&jg_pid=post-7' };
    expect(
      await resolveAttributionRefs(d, WS, known, parseAttribution(known), { sourceSocialPostId: 'post-1' }),
    ).toEqual({});
  });

  it('a bare click-id (fbclid, no UTM/jg params) stays stored-but-unresolved — no lookups', async () => {
    const d = db();
    const input = { url: 'https://x.co/lp?fbclid=ABC' };
    const refs = await resolveAttributionRefs(d, WS, input, parseAttribution(input), {});
    expect(refs).toEqual({});
    expect(d.adMetric.findFirst).not.toHaveBeenCalled();
  });
});
