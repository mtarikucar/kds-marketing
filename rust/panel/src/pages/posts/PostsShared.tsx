import { useQuery } from '@tanstack/react-query';
import { listCapabilities } from '@/api/capabilities';
import * as p from '@/api/posts';
import { useStudioKey } from '../StudioShared';

/** The query key of everything the Paylaşımlar tab reads, under Studio's. */
export function usePostsKey() {
  return [...useStudioKey(), 'posts'] as const;
}

/** The planned posts and the posting settings, which every view of the tab reads. */
export function usePosts() {
  const key = usePostsKey();
  return useQuery({ queryKey: [...key, 'list'], queryFn: () => p.postsList() });
}

/** A channel's name by its capability id; the id itself until the list is read. */
export function useChannelName(): (id: string | null) => string {
  const key = useStudioKey();
  const caps = useQuery({ queryKey: [...key, 'capabilities'], queryFn: () => listCapabilities() });
  return (id) => {
    if (!id) return '';
    return caps.data?.find((c) => c.capability.id === id)?.capability.name ?? id.slice(0, 8);
  };
}

/** Whether a planned post still waits to go out: not retired, its slot planned or ready. */
export function isLive(out: p.PostOut): boolean {
  return out.post.retired === null && (out.slot.state === 'planned' || out.slot.state === 'ready');
}

/** A reward (0–1) as a percentage. */
export function percent(mean: number, lang: string): string {
  return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(mean);
}
