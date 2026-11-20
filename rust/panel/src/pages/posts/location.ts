import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { STAGE_KEYS, type PostsFilter } from '@/api/postsPage';

/**
 * Where the Paylaşımlar page is, all of it in the address so links and the back button work
 * (design 2026-11-19 §2.11): the filter, the selected row (one of `slot`, `version`, `content`,
 * `need`), the TikTok posting dialog over it, and the three header drawers with their own place.
 */
export interface PostsPlace {
  f?: PostsFilter;
  slot?: string;
  version?: string;
  content?: string;
  need?: string;
  tiktok?: string;
  files?: boolean;
  queue?: boolean;
  /** An olay's id, or `genel`. */
  category?: string;
  file?: string;
  accounts?: boolean;
  account?: string;
  days?: 7 | 30 | 90;
  settings?: boolean;
  section?: SettingsSection;
  year?: number;
  /** `{key}:{year}` of a special day. */
  day?: string;
}

export type SettingsSection = 'rules' | 'days' | 'files';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['rules', 'days', 'files'];
const DAYS = [7, 30, 90] as const;
const FILTERS: readonly PostsFilter[] = ['you', ...STAGE_KEYS];

export function readPlace(params: URLSearchParams): PostsPlace {
  const f = params.get('f');
  const days = Number(params.get('days'));
  const year = Number(params.get('year'));
  const section = params.get('section');
  return {
    f: FILTERS.find((x) => x === f),
    slot: params.get('slot') || undefined,
    version: params.get('version') || undefined,
    content: params.get('content') || undefined,
    need: params.get('need') || undefined,
    tiktok: params.get('tiktok') || undefined,
    files: params.get('files') === '1' || undefined,
    queue: params.get('queue') === '1' || undefined,
    category: params.get('category') || undefined,
    file: params.get('file') || undefined,
    accounts: params.get('accounts') === '1' || undefined,
    account: params.get('account') || undefined,
    days: DAYS.find((d) => d === days),
    settings: params.get('settings') === '1' || undefined,
    section: SETTINGS_SECTIONS.find((s) => s === section),
    year: Number.isInteger(year) && year > 2000 ? year : undefined,
    day: params.get('day') || undefined,
  };
}

/** The address of `place`, its parameters always in one order (links compare as text). */
export function placeSearch(place: PostsPlace): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === false || value === '') return;
    params.set(key, value === true ? '1' : String(value));
  };
  put('f', place.f);
  put('slot', place.slot);
  put('version', place.version);
  put('content', place.content);
  put('need', place.need);
  put('tiktok', place.tiktok);
  put('files', place.files);
  if (place.files) {
    put('queue', place.queue);
    put('category', place.category);
  }
  put('file', place.file);
  put('accounts', place.accounts);
  if (place.accounts) {
    put('account', place.account);
    if (place.account) put('days', place.days);
  }
  put('settings', place.settings);
  if (place.settings) {
    put('section', place.section);
    put('year', place.year);
    put('day', place.day);
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

export const placeHref = (place: PostsPlace = {}) => `/posts${placeSearch(place)}`;

/** The row the address names, as a `content.post_get` row id; `undefined` when none. */
export function selectedRowId(place: PostsPlace): string | undefined {
  if (place.slot) return `slot:${place.slot}`;
  if (place.version) return `version:${place.version}`;
  if (place.content) return `content:${place.content}`;
  if (place.need) return `need:${place.need}`;
  return undefined;
}

/** The place with the row of `id` (`slot:…`, `version:…`, `content:…`, `need:…`) selected. */
export function withRow(place: PostsPlace, id: string | undefined): PostsPlace {
  const next: PostsPlace = { ...place, slot: undefined, version: undefined, content: undefined, need: undefined, tiktok: undefined };
  if (!id) return next;
  const at = id.indexOf(':');
  const kind = id.slice(0, at);
  const value = id.slice(at + 1);
  if (kind === 'slot') next.slot = value;
  else if (kind === 'version') next.version = value;
  else if (kind === 'content') next.content = value;
  else if (kind === 'need') next.need = value;
  return next;
}

/** No drawer, dialog or file open over the page. */
export const closedPlace = (place: PostsPlace): PostsPlace => ({
  f: place.f, slot: place.slot, version: place.version, content: place.content, need: place.need,
});

/** The page's location and a way to move it; a move is a new history entry unless `replace`. */
export function usePostsPlace() {
  const [params, setParams] = useSearchParams();
  const place = readPlace(params);
  const go = useCallback(
    (next: PostsPlace, options: { replace?: boolean } = {}) =>
      setParams(new URLSearchParams(placeSearch(next).slice(1)), { replace: options.replace }),
    [setParams],
  );
  return [place, go] as const;
}

// --- The addresses of the pages Paylaşımlar replaced (§2.11) ----------------------------------

const SOCIAL_WAITS = ['approvals', 'tiktok', 'failed', 'blocked'];

/** `/content…`: the content page's folders, queue, days, settings and `#eksikler`. */
function fromContent(params: URLSearchParams, hash: string): PostsPlace {
  if (hash === '#eksikler') return { f: 'you' };
  const place: PostsPlace = {};
  const content = params.get('content') ?? params.get('area') ?? params.get('project');
  if (content) place.content = content;
  const olay = params.get('olay');
  if (params.get('view') === 'queue') { place.files = true; place.queue = true; }
  if (olay) { place.files = true; place.category = olay; }
  const file = params.get('file');
  if (file) { place.files = true; place.file = file; }
  const day = params.get('day');
  const tab = params.get('tab');
  if (day || params.get('settings') === '1' || tab === 'calendar' || tab === 'settings') {
    place.settings = true;
    place.section = 'days';
    const year = Number(params.get('year'));
    if (Number.isInteger(year) && year > 2000) place.year = year;
    if (day) place.day = day;
  }
  return place;
}

/** `/social…`: the accounts, the posts, the filters, the settings and the old tabs. */
function fromSocial(params: URLSearchParams, hash: string): PostsPlace {
  const place: PostsPlace = {};
  const tab = params.get('tab') ?? params.get('section');
  const account = params.get('account');
  if (account) {
    place.accounts = true;
    place.account = account;
    const days = Number(params.get('days'));
    place.days = DAYS.find((d) => d === days);
  }
  const slot = params.get('slot');
  const tiktok = params.get('tiktok');
  if (slot) place.slot = slot;
  if (tiktok) { place.slot = tiktok; place.tiktok = tiktok; }
  const version = params.get('version');
  if (version) place.version = version;
  const filter = params.get('filter');
  if (filter && SOCIAL_WAITS.includes(filter)) place.f = 'you';
  if (filter === 'times') place.f = 'onay';
  if (params.get('settings') === '1' || tab === 'settings' || (tab === 'posts' && params.get('view') === 'settings')) {
    place.settings = true;
    place.section = 'rules';
  }
  if (tab === 'packages') {
    const named = hash.startsWith('#version-') ? decodeURIComponent(hash.slice('#version-'.length)) : '';
    if (named) place.version = named;
    else if (!place.version) place.f = 'onay';
  }
  return place;
}

/** `/studio…`: its tabs became the content and social pages, and then this one. */
function fromStudio(params: URLSearchParams): PostsPlace {
  if (params.get('tab') === 'materials') return fromMaterials(params);
  const place: PostsPlace = {};
  const content = params.get('content') ?? params.get('project') ?? params.get('area');
  if (content) place.content = content;
  const slot = params.get('slot');
  if (slot) place.slot = slot;
  return place;
}

/** `/materials…` and `/studio?tab=materials…`: the library is Dosyalar. */
function fromMaterials(params: URLSearchParams): PostsPlace {
  const place: PostsPlace = { files: true };
  const olay = params.get('olay');
  // `review` was a shelf, not an olay; Dosyalar's "İzin bekleyen" shows what waits for a person.
  if (olay && olay !== 'review') place.category = olay;
  const material = params.get('material');
  if (material) place.file = material;
  return place;
}

/** Where an address of a page Paylaşımlar replaced lands (one `replace`, the query mapped). */
export function legacyTarget(page: 'content' | 'social' | 'studio' | 'materials', search: string, hash = ''): string {
  const params = new URLSearchParams(search);
  const place =
    page === 'content' ? fromContent(params, hash)
      : page === 'social' ? fromSocial(params, hash)
        : page === 'studio' ? fromStudio(params)
          : fromMaterials(params);
  return placeHref(place);
}
