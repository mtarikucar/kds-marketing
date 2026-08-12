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

/**
 * The strategist writes the human-facing title on the ACTION — that is what the
 * submit schema asks of it — so the executor must fall back to it instead of
 * demanding a duplicate inside the payload. The old contract failed a real,
 * perfectly-titled action with "CONTENT payload requires a non-empty title".
 */
describe('ContentExecutor — action title/rationale fallback', () => {
  it('drafts from the action title when the payload has none', async () => {
    const { svc: executor, content, planner } = deps({ post: { id: 'post-9', status: 'DRAFT' } });

    const res = await executor.run(
      'ws1',
      { channelKey: 'instagram', format: 'reels' },
      { title: 'Before/After foto→figür Reels serisi', rationale: 'Benzeyecek mi itirazını kanıtla yıkar' },
    );

    expect(res.resultRef).toBe('post:post-9');
    const arg = content.compose.mock.calls[0][1];
    // Title from the action; the rationale serves as the angle.
    expect(arg.goal).toContain('Before/After foto→figür Reels serisi');
    expect(arg.goal).toContain('Benzeyecek mi itirazını kanıtla yıkar');
  });

  it('payload.title still wins when both exist', async () => {
    const { svc: executor, content } = deps();

    await executor.run('ws1', { title: 'Payload başlığı' }, { title: 'Aksiyon başlığı', rationale: 'r' });

    expect(content.compose.mock.calls[0][1].goal).toContain('Payload başlığı');
  });

  it('still refuses when neither the payload nor the action carries a title', async () => {
    const { svc: executor } = deps();
    await expect(executor.run('ws1', { channelKey: 'x' })).rejects.toThrow(/requires a non-empty title/);
  });
});
