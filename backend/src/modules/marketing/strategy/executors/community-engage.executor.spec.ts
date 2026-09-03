import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

// The channel adapters are module-level functions; mock them so no test ever
// touches live Discord/Reddit and we can drive the configured/ok/fail branches.
jest.mock('../channels/discord.adapter', () => ({
  resolveDiscordWebhookUrl: jest.fn(async () => null),
  isDiscordConfigured: jest.fn(async () => false),
  postToDiscord: jest.fn(async () => ({ ok: true, id: 'dmsg1' })),
}));
jest.mock('../channels/reddit.adapter', () => ({
  isRedditConfigured: jest.fn(async () => false),
  postToReddit: jest.fn(async () => ({ ok: true, id: 'rt3_1' })),
}));

import { CommunityEngageExecutor } from './community-engage.executor';
import { resolveDiscordWebhookUrl, postToDiscord } from '../channels/discord.adapter';
import { isRedditConfigured, postToReddit } from '../channels/reddit.adapter';

const mResolveDiscord = resolveDiscordWebhookUrl as jest.Mock;
const mPostDiscord = postToDiscord as jest.Mock;
const mIsReddit = isRedditConfigured as jest.Mock;
const mPostReddit = postToReddit as jest.Mock;

function deps(overrides: { compose?: any; composeError?: any; post?: any; verdict?: any } = {}) {
  const content = {
    compose: jest.fn(async () => {
      if (overrides.composeError) throw overrides.composeError;
      return overrides.compose ?? { body: 'Remember grinding the spider dungeon? Come home. 🕷️' };
    }),
  };
  const planner = {
    createPost: jest.fn().mockResolvedValue(overrides.post ?? { id: 'post1', status: 'DRAFT' }),
  };
  // The community-channel service is only consumed through the mocked adapters
  // (which take it as an opaque handle), so a stub identity is sufficient here.
  const channels = { __tag: 'CommunityChannelService' } as any;
  // The shared screen every publish path in this product goes through. Default
  // SAFE so the pre-existing cases describe the same behaviour they always did.
  const brandSafety = { screen: jest.fn(async () => overrides.verdict ?? 'SAFE') };
  const svc = new CommunityEngageExecutor(content as any, planner as any, channels, brandSafety as any);
  return { svc, content, planner, channels, brandSafety };
}

const PAYLOAD = {
  channelKey: 'reddit',
  community: 'r/Metin2',
  title: 'Remember the spider dungeon?',
  angle: 'nostalgia',
  tone: 'playful',
  format: 'meme',
};

describe('CommunityEngageExecutor', () => {
  beforeEach(() => {
    // Default: nothing configured → stage-a-draft is the safe default.
    mResolveDiscord.mockResolvedValue(null);
    mPostDiscord.mockResolvedValue({ ok: true, id: 'dmsg1' });
    mIsReddit.mockResolvedValue(false);
    mPostReddit.mockResolvedValue({ ok: true, id: 'rt3_1' });
  });
  afterEach(() => jest.clearAllMocks());

  it('has kind COMMUNITY_ENGAGE', () => {
    expect(deps().svc.kind).toBe('COMMUNITY_ENGAGE');
  });

  it('composes community-native copy, stages a DRAFT noting the target community, returns the community ref', async () => {
    const { svc, content, planner } = deps();
    const r = await svc.run('ws1', PAYLOAD);

    expect(content.compose).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        kind: 'social',
        goal: expect.stringContaining('Remember the spider dungeon?'),
        tone: 'playful',
        context: expect.stringContaining('r/Metin2'),
      }),
    );
    expect(content.compose.mock.calls[0][1].context).toMatch(/meme/i);

    const createArg = planner.createPost.mock.calls[0][1];
    expect(createArg.content).toContain('Remember grinding the spider dungeon?');
    expect(createArg.options).toMatchObject({ channelKey: 'reddit', community: 'r/Metin2', format: 'meme' });

    // Reddit not configured → safe default: staged draft, no live submit.
    expect(mPostReddit).not.toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'community:post1' });
  });

  it('builds the goal from title + angle when both are present', async () => {
    const { svc, content } = deps();
    await svc.run('ws1', PAYLOAD);
    expect(content.compose.mock.calls[0][1].goal).toContain('nostalgia');
  });

  it('degrades gracefully (resultRef undefined) when AI is unconfigured', async () => {
    const { svc, planner } = deps({ composeError: new ServiceUnavailableException('AI is not configured') });
    const r = await svc.run('ws1', PAYLOAD);
    expect(r).toEqual({ resultRef: undefined });
    expect(planner.createPost).not.toHaveBeenCalled();
  });

  it('rethrows non-availability errors from compose', async () => {
    const { svc } = deps({ composeError: new Error('boom') });
    await expect(svc.run('ws1', PAYLOAD)).rejects.toThrow('boom');
  });

  it('throws on a missing community', async () => {
    const { svc, content } = deps();
    await expect(svc.run('ws1', { channelKey: 'reddit', title: 'x' })).rejects.toThrow(BadRequestException);
    expect(content.compose).not.toHaveBeenCalled();
  });

  it('throws on a missing title', async () => {
    const { svc } = deps();
    await expect(svc.run('ws1', { channelKey: 'reddit', community: 'r/Metin2' })).rejects.toThrow(BadRequestException);
  });

  it('throws on a non-object payload', async () => {
    const { svc } = deps();
    await expect(svc.run('ws1', null)).rejects.toThrow(BadRequestException);
  });

  // ─────────────────────────────── P5 live posting (opt-in, owned channels)

  it('posts to Discord when configured and returns the discord ref (no draft staged)', async () => {
    mResolveDiscord.mockResolvedValue('https://discord.com/api/webhooks/1/x');
    mPostDiscord.mockResolvedValue({ ok: true, id: 'dmsg9' });
    const { svc, planner } = deps();

    const r = await svc.run('ws1', { ...PAYLOAD, channelKey: 'discord' });

    expect(mPostDiscord).toHaveBeenCalledWith('https://discord.com/api/webhooks/1/x', {
      content: 'Remember grinding the spider dungeon? Come home. 🕷️',
    });
    expect(planner.createPost).not.toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'discord:dmsg9' });
  });

  it('falls back to staging a draft when the Discord post fails', async () => {
    mResolveDiscord.mockResolvedValue('https://discord.com/api/webhooks/1/x');
    mPostDiscord.mockResolvedValue({ ok: false, error: 'HTTP 401' });
    const { svc, planner } = deps();

    const r = await svc.run('ws1', { ...PAYLOAD, channelKey: 'discord' });

    expect(mPostDiscord).toHaveBeenCalled();
    expect(planner.createPost).toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'community:post1' });
  });

  it('submits to Reddit when configured and returns the reddit ref (no draft staged)', async () => {
    mIsReddit.mockResolvedValue(true);
    mPostReddit.mockResolvedValue({ ok: true, id: 'abc123' });
    const { svc, planner, channels } = deps();

    const r = await svc.run('ws1', PAYLOAD); // channelKey 'reddit'

    expect(mPostReddit).toHaveBeenCalledWith('ws1', channels, {
      subreddit: 'r/Metin2',
      title: 'Remember the spider dungeon?',
      text: 'Remember grinding the spider dungeon? Come home. 🕷️',
    });
    expect(planner.createPost).not.toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'reddit:abc123' });
  });

  it('falls back to staging a draft when the Reddit submit fails', async () => {
    mIsReddit.mockResolvedValue(true);
    mPostReddit.mockResolvedValue({ ok: false, error: 'SUBREDDIT_NOEXIST' });
    const { svc, planner } = deps();

    const r = await svc.run('ws1', PAYLOAD);

    expect(mPostReddit).toHaveBeenCalled();
    expect(planner.createPost).toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'community:post1' });
  });

  it('stages a draft for an unconfigured/other channel (unchanged behaviour)', async () => {
    const { svc, planner } = deps();
    const r = await svc.run('ws1', { ...PAYLOAD, channelKey: 'forum', community: 'Some Forum' });
    expect(mPostDiscord).not.toHaveBeenCalled();
    expect(mPostReddit).not.toHaveBeenCalled();
    expect(planner.createPost).toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'community:post1' });
  });

  // ───────────────────────────────── brand safety (the live-publish gate)
  //
  // This executor posts machine-written copy into real Discord servers and real
  // subreddits with nobody in the loop — the AUTONOMOUS lane exists so the owner
  // never has to look. Every other publish path in the product screens its copy
  // first; this one did not, and the only thing standing between an unattended
  // LLM and a live community was whether an env var happened to be empty. These
  // cases are that gate.

  it('screens the copy BEFORE a live Discord post, and posts what it screened', async () => {
    mResolveDiscord.mockResolvedValue('https://discord.com/api/webhooks/1/x');
    const { svc, brandSafety } = deps();
    await svc.run('ws1', { ...PAYLOAD, channelKey: 'discord' });
    expect(brandSafety.screen).toHaveBeenCalledWith('ws1', 'Remember grinding the spider dungeon? Come home. 🕷️');
    // Order matters more than the call itself: a screen after the post is not a gate.
    expect(brandSafety.screen.mock.invocationCallOrder[0])
      .toBeLessThan(mPostDiscord.mock.invocationCallOrder[0]);
  });

  it('screens the Reddit TITLE as well as the body — the title is what the subreddit reads', async () => {
    mIsReddit.mockResolvedValue(true);
    const { svc, brandSafety } = deps();
    await svc.run('ws1', PAYLOAD);
    const screened = brandSafety.screen.mock.calls[0][1];
    expect(screened).toContain('Remember the spider dungeon?');
    expect(screened).toContain('Remember grinding the spider dungeon?');
  });

  it('BLOCK: nothing is posted, nothing is staged, and the action FAILS with the reason', async () => {
    // A refusal must not become a draft. Staging it would put copy a reviewer
    // just called unsafe one click from publishing in the customer's own
    // planner — and the action would come back DONE with a resultRef, so the
    // morning brief would report the refusal as work applied.
    mResolveDiscord.mockResolvedValue('https://discord.com/api/webhooks/1/x');
    const { svc, planner } = deps({ verdict: 'BLOCK' });
    await expect(svc.run('ws1', { ...PAYLOAD, channelKey: 'discord' })).rejects.toThrow(/marka güvenliği/);
    expect(mPostDiscord).not.toHaveBeenCalled();
    expect(planner.createPost).not.toHaveBeenCalled();
  });

  it('BLOCK on Reddit: no submit, no draft', async () => {
    mIsReddit.mockResolvedValue(true);
    const { svc, planner } = deps({ verdict: 'BLOCK' });
    await expect(svc.run('ws1', PAYLOAD)).rejects.toThrow(BadRequestException);
    expect(mPostReddit).not.toHaveBeenCalled();
    expect(planner.createPost).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: an unreadable verdict stages a draft instead of posting live', async () => {
    // The social-campaign path fails OPEN here, deliberately, because a person
    // built that campaign and can see the item. Nobody is watching this one, the
    // copy is minutes old, and a post into someone else's community cannot be
    // retracted — so an outage means a human looks at it, not that it goes out.
    mResolveDiscord.mockResolvedValue('https://discord.com/api/webhooks/1/x');
    const { svc, planner } = deps({ verdict: 'UNAVAILABLE' });
    const r = await svc.run('ws1', { ...PAYLOAD, channelKey: 'discord' });
    expect(mPostDiscord).not.toHaveBeenCalled();
    expect(planner.createPost).toHaveBeenCalled();
    expect(r).toEqual({ resultRef: 'community:post1' });
  });

  it('does not pay for a screen when there is nothing to publish to', async () => {
    // The screen costs a credit and a provider call. The draft path publishes
    // nothing and puts the copy in front of a person, which is a stronger
    // review than this one — so an unconfigured workspace is not billed for it.
    const { svc, brandSafety, planner } = deps();
    await svc.run('ws1', PAYLOAD); // reddit, not configured
    expect(brandSafety.screen).not.toHaveBeenCalled();
    expect(planner.createPost).toHaveBeenCalled();
  });
});
