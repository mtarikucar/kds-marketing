import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The kinds of "Sizi bekleyenler": each one a chip that filters the waiting posts. */
export const WAIT_KINDS = ['approvals', 'tiktok', 'failed', 'times', 'blocked'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/**
 * Where the social page is, all of it in the address so links and the back button work: the
 * account (or `view=all`, every account, on a phone), the open post (`slot`, its slot's id) or
 * waiting version (`version`), a filter of the waiting posts, the account's period, and over it
 * the settings or a TikTok post's posting screen.
 *
 * `/social` with none of `account`, `view`, `slot`, `version`, `filter` is home: the accounts
 * beside every account's posts on a desk, the accounts alone on a phone.
 */
export interface SocialPlace {
  account?: string;
  view?: 'all';
  slot?: string;
  version?: string;
  filter?: WaitKind;
  days?: 7 | 30 | 90;
  settings?: boolean;
  tiktok?: string;
}

const DAYS = [7, 30, 90] as const;

export function readPlace(params: URLSearchParams): SocialPlace {
  const filter = params.get('filter');
  const days = Number(params.get('days'));
  return {
    account: params.get('account') || undefined,
    view: params.get('view') === 'all' ? 'all' : undefined,
    slot: params.get('slot') || undefined,
    version: params.get('version') || undefined,
    filter: WAIT_KINDS.find((k) => k === filter),
    days: DAYS.find((d) => d === days),
    settings: params.get('settings') === '1' || undefined,
    tiktok: params.get('tiktok') || undefined,
  };
}

export function placeSearch(place: SocialPlace): string {
  const params = new URLSearchParams();
  if (place.account) params.set('account', place.account);
  else if (place.view) params.set('view', place.view);
  if (place.account && place.days) params.set('days', String(place.days));
  if (place.filter) params.set('filter', place.filter);
  if (place.slot) params.set('slot', place.slot);
  if (place.version) params.set('version', place.version);
  if (place.settings) params.set('settings', '1');
  if (place.tiktok) params.set('tiktok', place.tiktok);
  const search = params.toString();
  return search ? `?${search}` : '';
}

export const placeHref = (place: SocialPlace) => `/social${placeSearch(place)}`;

/** No account, view, open post or filter: home (the accounts alone on a phone). */
export const isHome = (place: SocialPlace) => !place.account && !place.view && !place.slot && !place.version && !place.filter;

/**
 * Old addresses of the tabs this page replaced, rewritten in place: `?tab=packages` (with
 * `#version-<id>` for one version), `?tab=settings` / `?section=settings` /
 * `?tab=posts&view=settings`, and the other old tabs (`accounts`, `posts`, `plan`).
 */
export function legacyTarget(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get('tab') ?? params.get('section');
  if (!tab && !(params.get('view') && params.get('view') !== 'all')) return null;
  const place = readPlace(params);
  if (tab === 'packages') {
    const version = hash.startsWith('#version-') ? decodeURIComponent(hash.slice('#version-'.length)) : '';
    if (version) place.version = version;
    else place.filter = 'times';
  }
  if (tab === 'settings' || (tab === 'posts' && params.get('view') === 'settings')) place.settings = true;
  if (place.view !== 'all') place.view = undefined;
  return placeHref(place);
}

/** The page's location and a way to move it; a move is a new history entry unless `replace`. */
export function useSocialPlace() {
  const [params, setParams] = useSearchParams();
  const place = readPlace(params);
  const go = useCallback(
    (next: SocialPlace, options: { replace?: boolean } = {}) =>
      setParams(new URLSearchParams(placeSearch(next).slice(1)), { replace: options.replace }),
    [setParams],
  );
  return [place, go] as const;
}
