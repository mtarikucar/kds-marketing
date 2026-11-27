import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getPlaybook } from '@/api/prospects';
import { getStrategy } from '@/api/strategy';
import type { IcpEntry, Segment } from '@/api/types';
import { useLeadsKey } from '../LeadsShared';
import { keyWords } from './purpose';

/** One choice of the audience filter. */
export interface SegmentOption {
  key: string;
  name: string;
}

/**
 * The audience filter's choices, read from this workspace's own strategy and never from a fixed
 * list: one per audience segment that an ICP entry names, in the entries' order, then any segment
 * a listed prospect carries, then the filter's current value (a link, or a segment the strategy
 * no longer prospects for). Each is shown under the audience's name, or its key when the strategy
 * cannot be read.
 */
export function segmentOptions(
  icp: readonly Pick<IcpEntry, 'segment_key'>[],
  audience: readonly Pick<Segment, 'key' | 'name'>[],
  carried: readonly (string | null)[] = [],
  current = '',
): SegmentOption[] {
  const names = new Map(audience.map((s) => [s.key, s.name]));
  const keys: string[] = [];
  for (const key of [...icp.map((e) => e.segment_key), ...carried, current]) {
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.map((key) => ({ key, name: names.get(key) || key }));
}

/**
 * This workspace's purposes for the pool: one per ICP entry (the "sales door" a candidate is
 * sought for), in the entries' order, then any a prospect in view carries, then `current`. An ICP
 * entry has no name of its own: its key is shown as words.
 */
export function usePoolPurposes(carried: readonly (string | null)[] = [], current = ''): SegmentOption[] {
  const key = useLeadsKey();
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const book = useQuery({ queryKey: [...key, 'prospects', 'playbook'], queryFn: getPlaybook, retry: false });
  const carriedKey = carried.filter(Boolean).join('|');
  return useMemo(() => {
    const keys: string[] = [];
    for (const k of [...(book.data?.workspace.icp ?? []).map((e) => e.key), ...(carriedKey ? carriedKey.split('|') : []), current]) {
      if (k && !keys.includes(k)) keys.push(k);
    }
    return keys.map((k) => ({ key: k, name: keyWords(k, language) }));
  }, [book.data, carriedKey, current, language]);
}

/**
 * This workspace's audience segments for the pool: the ICP entries say which ones prospecting
 * works for, the strategy's audience names them (a member who cannot read the strategy sees their
 * keys). `carried` are the segments of the prospects in view, `current` a value to keep offered.
 */
export function usePoolSegments(carried: readonly (string | null)[] = [], current = ''): SegmentOption[] {
  const key = useLeadsKey();
  const book = useQuery({ queryKey: [...key, 'prospects', 'playbook'], queryFn: getPlaybook, retry: false });
  const strategy = useQuery({ queryKey: [...key, 'prospects', 'audience'], queryFn: getStrategy, retry: false });
  const carriedKey = carried.filter(Boolean).join('|');
  return useMemo(
    () =>
      segmentOptions(
        book.data?.workspace.icp ?? [],
        strategy.data?.approved?.sections.audience ?? [],
        carriedKey ? carriedKey.split('|') : [],
        current,
      ),
    [book.data, strategy.data, carriedKey, current],
  );
}
