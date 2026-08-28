import marketingApi from './marketingApi';

export type TimelineKind = 'system' | 'task' | 'appointment' | 'campaign';

export interface TimelineItem {
  kind: TimelineKind;
  at: string;
  title: string;
  id: string;
  status?: string;
}

export interface HomeTimeline {
  from: string;
  to: string;
  items: TimelineItem[];
  /** Sources that could not be read, by name — the list is missing rows and we
   *  do not know how many. */
  unread: string[];
  /** Sources that answered with more rows than fit the cap, by name — what came
   *  back is the EARLIEST of them, not an arbitrary slice. Kept apart from
   *  `unread` because the two failures need different fixes. */
  truncated: string[];
}

/**
 * GET /marketing/home/timeline — the home screen's calendar panel.
 *
 * `marketingApi` already carries `${API_URL}/marketing` as its baseURL, so the
 * path here is the route's tail only.
 *
 * The window is the backend's default (now → +7 days); no query string is sent
 * because the panel has no window picker yet. When one is added, `from`/`to`
 * ISO instants go here — the controller falls back rather than 400s on garbage.
 */
export const getHomeTimeline = () =>
  marketingApi
    .get<HomeTimeline>('/home/timeline')
    .then((r) => r.data);
