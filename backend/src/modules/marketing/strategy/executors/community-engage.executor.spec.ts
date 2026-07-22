import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { CommunityEngageExecutor } from './community-engage.executor';

function deps(overrides: { compose?: any; composeError?: any; post?: any } = {}) {
  const content = {
    compose: jest.fn(async () => {
      if (overrides.composeError) throw overrides.composeError;
      return overrides.compose ?? { body: 'Remember grinding the spider dungeon? Come home. 🕷️' };
    }),
  };
  const planner = {
    createPost: jest.fn().mockResolvedValue(overrides.post ?? { id: 'post1', status: 'DRAFT' }),
  };
  const svc = new CommunityEngageExecutor(content as any, planner as any);
  return { svc, content, planner };
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
        // The community + native format are threaded into the compose context.
        context: expect.stringContaining('r/Metin2'),
      }),
    );
    expect(content.compose.mock.calls[0][1].context).toMatch(/meme/i);

    // The staged draft notes the target community (posting itself is P5).
    const createArg = planner.createPost.mock.calls[0][1];
    expect(createArg.content).toContain('Remember grinding the spider dungeon?');
    expect(createArg.options).toMatchObject({ channelKey: 'reddit', community: 'r/Metin2', format: 'meme' });

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
});
