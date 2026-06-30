import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));

import marketingApi from './marketingApi';
import {
  generateMedia,
  listGenerations,
  getGeneration,
  regenerateMedia,
  deleteGeneration,
  isTerminal,
} from './media.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('media.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateMedia POSTs the payload to /ai/media/generate and returns { assetId }', async () => {
    api.post.mockResolvedValue({ data: { assetId: 'a-1' } });
    const out = await generateMedia({ type: 'IMAGE', prompt: 'a cat', aspectRatio: '1:1' });
    expect(api.post).toHaveBeenCalledWith('/ai/media/generate', {
      type: 'IMAGE',
      prompt: 'a cat',
      aspectRatio: '1:1',
    });
    expect(out).toEqual({ assetId: 'a-1' });
  });

  it('listGenerations passes filters as query params', async () => {
    api.get.mockResolvedValue({ data: [] });
    await listGenerations({ type: 'VIDEO', status: 'READY' });
    expect(api.get).toHaveBeenCalledWith('/ai/media/generations', {
      params: { type: 'VIDEO', status: 'READY' },
    });
  });

  it('getGeneration hits the :id status route', async () => {
    api.get.mockResolvedValue({ data: { id: 'a-1', status: 'GENERATING' } });
    const a = await getGeneration('a-1');
    expect(api.get).toHaveBeenCalledWith('/ai/media/generations/a-1');
    expect(a.status).toBe('GENERATING');
  });

  it('regenerateMedia and deleteGeneration use the right verbs/paths', async () => {
    api.post.mockResolvedValue({ data: { assetId: 'a-2' } });
    api.delete.mockResolvedValue({ data: { message: 'ok' } });
    expect(await regenerateMedia('a-1')).toEqual({ assetId: 'a-2' });
    expect(api.post).toHaveBeenCalledWith('/ai/media/generations/a-1/regenerate');
    expect(await deleteGeneration('a-1')).toEqual({ message: 'ok' });
    expect(api.delete).toHaveBeenCalledWith('/ai/media/generations/a-1');
  });

  it('isTerminal is true only for READY/FAILED/BLOCKED', () => {
    expect(isTerminal('READY')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('BLOCKED')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('GENERATING')).toBe(false);
  });
});
