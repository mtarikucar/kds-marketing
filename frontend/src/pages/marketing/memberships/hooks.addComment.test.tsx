import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useCommunityMutations, communityPostsKey, postCommentsKey } from './hooks';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: { id: 'cm1' } }) },
}));

describe('useCommunityMutations.addComment — cache invalidation', () => {
  // The "N comments" badge reads post._count.comments, served by the posts-list
  // query (communityPostsKey). addComment only invalidated the comment LIST, so
  // the badge stayed stale after commenting. It must refresh BOTH.
  it('refreshes the posts list (comment-count badge) AND the comment list', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCommunityMutations('c1'), { wrapper });

    await result.current.addComment.mutateAsync({ postId: 'p1', body: 'hi' });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: postCommentsKey('p1') }),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: communityPostsKey('c1') }),
    );
  });
});
