/**
 * Where a failed approval survives the panel that reported it.
 *
 * The decision now happens in `IdeaDetail`, a `?idea=` surface the operator
 * closes the moment they have read it — and the failure used to be component
 * state, so closing it erased the only durable account of what went wrong.
 * Reopening the link cannot recover it either: the row has left PROPOSED.
 *
 * The query cache is the channel because the two components are siblings
 * mounted by different branches of StudioOneScreen, and because a value put
 * here outlives the unmount of whoever wrote it. It is never fetched — only
 * written by the detail and read by the panel.
 */
export const IDEA_FAILURE_KEY = ['marketing', 'strategy', 'ideas', 'last-failure'] as const;

export interface IdeaFailure {
  id: string;
  title: string;
  /** Carries the reason: `resultRef` holds `error:<message>` for a failed run. */
  resultRef: string | null;
}
