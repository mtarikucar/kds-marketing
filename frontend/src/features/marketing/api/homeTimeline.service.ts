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
  /**
   * The nightly research queue and who is (not) draining it. `null` ONLY when
   * the backend could not read it — in which case it has already named itself
   * in `unread`, so the panel adds nothing of its own.
   *
   * `mode: 'MCP'` means the workspace handed research execution to its OWN
   * Claude and the platform stopped draining the queue. A backlog there is the
   * owner's scheduled task to fix; a backlog under `'SERVER'` is ours, and
   * saying the wrong one sends somebody to fix something that is not theirs.
   */
  research: {
    mode: 'SERVER' | 'MCP';
    pending: number;
    claimed: number;
    oldestPendingAt: string | null;
    oldestPendingAgeHours: number | null;
    /**
     * When the oldest LIVE lease was taken, and how long ago in minutes.
     *
     * `claimed` on its own cannot be rendered honestly: a job held for four
     * minutes is a drainer at work, a job held for a day is a drainer that
     * never came back. Minutes because the lease is thirty of them by default.
     */
    oldestClaimedAt: string | null;
    oldestClaimedAgeMinutes: number | null;
    /** Nights fully researched but held in the human approval queue. */
    pendingApprovals: number;
  } | null;
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
