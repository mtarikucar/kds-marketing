import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import marketingApi from './marketingApi';
import {
  startIntake,
  answerIntake,
  finishIntake,
  getStrategy,
  listStrategyActions,
  approveAction,
  dismissAction,
  setStrategyAutonomy,
} from './strategy.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

describe('strategy.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('startIntake POSTs /strategy/intake/start with url + optional fields', async () => {
    api.post.mockResolvedValue({ data: { sessionId: 's1', questions: ['q1', 'q2'] } });
    const res = await startIntake({ url: 'https://acme.com', oneLiner: 'we sell x' });
    expect(api.post).toHaveBeenCalledWith('/strategy/intake/start', {
      url: 'https://acme.com',
      oneLiner: 'we sell x',
    });
    expect(res).toEqual({ sessionId: 's1', questions: ['q1', 'q2'] });
  });

  it('startIntake surfaces a {skipped} result unchanged', async () => {
    api.post.mockResolvedValue({ data: { skipped: true } });
    expect(await startIntake({ url: 'https://acme.com' })).toEqual({ skipped: true });
  });

  it('answerIntake POSTs sessionId + answers', async () => {
    api.post.mockResolvedValue({ data: { done: true } });
    const res = await answerIntake('s1', ['a1', 'a2']);
    expect(api.post).toHaveBeenCalledWith('/strategy/intake/answer', {
      sessionId: 's1',
      answers: ['a1', 'a2'],
    });
    expect(res).toEqual({ done: true });
  });

  it('finishIntake POSTs the sessionId and returns the created strategy id', async () => {
    api.post.mockResolvedValue({ data: { strategyId: 'st1', actionCount: 4 } });
    const res = await finishIntake('s1');
    expect(api.post).toHaveBeenCalledWith('/strategy/intake/finish', { sessionId: 's1' });
    expect(res).toEqual({ strategyId: 'st1', actionCount: 4 });
  });

  it('getStrategy GETs /strategy and passes the row through', async () => {
    const row = { id: 'st1', archetype: 'CHALLENGER', brief: {}, autonomyLevel: 'ASSISTED', status: 'ACTIVE', version: 1 };
    api.get.mockResolvedValue({ data: row });
    expect(await getStrategy()).toEqual(row);
    expect(api.get).toHaveBeenCalledWith('/strategy');
  });

  it('getStrategy returns null for a null body', async () => {
    api.get.mockResolvedValue({ data: null });
    expect(await getStrategy()).toBeNull();
  });

  it('getStrategy swallows a 404 into null', async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });
    expect(await getStrategy()).toBeNull();
  });

  it('getStrategy rethrows non-404 errors', async () => {
    api.get.mockRejectedValue({ response: { status: 500 } });
    await expect(getStrategy()).rejects.toBeTruthy();
  });

  it('listStrategyActions GETs /strategy/actions with the status param', async () => {
    api.get.mockResolvedValue({ data: [] });
    await listStrategyActions('PROPOSED');
    expect(api.get).toHaveBeenCalledWith('/strategy/actions', { params: { status: 'PROPOSED' } });
  });

  it('listStrategyActions defaults the status to PROPOSED', async () => {
    api.get.mockResolvedValue({ data: [] });
    await listStrategyActions();
    expect(api.get).toHaveBeenCalledWith('/strategy/actions', { params: { status: 'PROPOSED' } });
  });

  it('approveAction POSTs the approve route', async () => {
    api.post.mockResolvedValue({ data: { id: 'a1', status: 'APPROVED' } });
    await approveAction('a1');
    expect(api.post).toHaveBeenCalledWith('/strategy/actions/a1/approve');
  });

  it('dismissAction POSTs the dismiss route', async () => {
    api.post.mockResolvedValue({ data: { id: 'a1', status: 'DISMISSED' } });
    await dismissAction('a1');
    expect(api.post).toHaveBeenCalledWith('/strategy/actions/a1/dismiss');
  });

  it('setStrategyAutonomy POSTs the level', async () => {
    api.post.mockResolvedValue({ data: { id: 'st1', autonomyLevel: 'AUTONOMOUS' } });
    await setStrategyAutonomy('AUTONOMOUS');
    expect(api.post).toHaveBeenCalledWith('/strategy/autonomy', { level: 'AUTONOMOUS' });
  });
});
