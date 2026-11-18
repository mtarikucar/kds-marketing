import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMaterialsKey } from '../materials/MaterialsShared';

/**
 * Where the content page is, all of it in the address so links and the back button work: the
 * folder (an olay's id or `genel`), a coming special day (`<key>:<year>`) or the analysis queue,
 * and over it the open file, the expanded content and the settings.
 *
 * `/content` with none of `olay`, `day`, `view` is home: the tree beside the production line on
 * a desk, the tree alone on a phone (`view=all` is the production line on both).
 */
export interface ContentPlace {
  olay?: string;
  day?: string;
  view?: 'all' | 'queue';
  content?: string;
  file?: string;
  settings?: boolean;
  year?: number;
}

export function readPlace(params: URLSearchParams): ContentPlace {
  const view = params.get('view');
  const year = Number(params.get('year'));
  return {
    olay: params.get('olay') || undefined,
    day: params.get('day') || undefined,
    view: view === 'all' || view === 'queue' ? view : undefined,
    content: params.get('content') || undefined,
    file: params.get('file') || undefined,
    settings: params.get('settings') === '1' || undefined,
    year: Number.isInteger(year) && year > 2000 ? year : undefined,
  };
}

export function placeSearch(place: ContentPlace): string {
  const params = new URLSearchParams();
  if (place.olay) params.set('olay', place.olay);
  else if (place.day) params.set('day', place.day);
  else if (place.view) params.set('view', place.view);
  if (place.content) params.set('content', place.content);
  if (place.file) params.set('file', place.file);
  if (place.settings) params.set('settings', '1');
  if (place.settings && place.year) params.set('year', String(place.year));
  const search = params.toString();
  return search ? `?${search}` : '';
}

export const placeHref = (place: ContentPlace) => `/content${placeSearch(place)}`;

/** A place with no folder, day or view: home. */
export const isHome = (place: ContentPlace) => !place.olay && !place.day && !place.view;

/** The folder an area belongs to: its olay, or Genel. */
export const folderOf = (olayId: string | null | undefined) => olayId ?? 'genel';

/** The page's location and a way to move it; a move is a new history entry unless `replace`. */
export function useContentPlace() {
  const [params, setParams] = useSearchParams();
  const place = readPlace(params);
  const go = useCallback(
    (next: ContentPlace, options: { replace?: boolean } = {}) =>
      setParams(new URLSearchParams(placeSearch(next).slice(1)), { replace: options.replace }),
    [setParams],
  );
  return [place, go] as const;
}

/** Everything the content page reads, under the library's key (a library write refreshes it). */
export function useContentKey() {
  return [...useMaterialsKey(), 'content'] as const;
}
