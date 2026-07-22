import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ContentExecutor } from './content.executor';

function deps(overrides: { compose?: any; composeError?: any; post?: any } = {}) {
  const content = {
    compose: jest.fn(async () => {
      if (overrides.composeError) throw overrides.composeError;
      return overrides.compose ?? { body: 'Nostalgia never dies. Come home. 🎮' };
    }),
  };
  const planner = {
    createPost: jest.fn().mockResolvedValue(overrides.post ?? { id: 'post1', status: 'DRAFT' }),
  };
  const svc = new ContentExecutor(content as any, planner as any);
  return { svc, content, planner };
}

const PAYLOAD = {
  title: 'Weekly nostalgia clips',
  angle: 'classic-era gameplay',
  formats: ['reel', 'meme'],
  tone: 'playful',
  channelKey: 'instagram',
};

describe('ContentExecutor', () => {
  it('has kind CONTENT', () => {
    expect(deps().svc.kind).toBe('CONTENT');
  });

  it('composes a social draft from the pillar and stages it, returning the post ref', async () => {
    const { svc, content, planner } = deps();
    const r = await svc.run('ws1', PAYLOAD);

    expect(content.compose).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        kind: 'social',
        goal: expect.stringContaining('Weekly nostalgia clips'),
        tone: 'playful',
      }),
    );
    expect(planner.createPost).toHaveBeenCalledWith('ws1', { content: 'Nostalgia never dies. Come home. 🎮' });
    expect(r).toEqual({ resultRef: 'post:post1' });
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

  it('throws on a missing title', async () => {
    const { svc, content } = deps();
    await expect(svc.run('ws1', {})).rejects.toThrow(BadRequestException);
    await expect(svc.run('ws1', { title: '   ' })).rejects.toThrow(BadRequestException);
    expect(content.compose).not.toHaveBeenCalled();
  });

  it('throws on a non-object payload', async () => {
    const { svc } = deps();
    await expect(svc.run('ws1', null)).rejects.toThrow(BadRequestException);
  });
});
