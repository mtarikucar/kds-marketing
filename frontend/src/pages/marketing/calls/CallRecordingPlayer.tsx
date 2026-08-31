import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import {
  getCallRecording,
  type CallRecordingResult,
} from '../../../features/marketing/api/voice-ai.service';
import { Button, Spinner } from '../../../components/ui';

/**
 * CallRecordingPlayer — in-app playback for a SalesCall's recording (NetGSM
 * Phase 4 Task 3). Replaces the raw cross-origin `<a href={recordingUrl}>`
 * link the calls table used to render (a direct link to NetGSM's tokenized
 * recording URL, opened in a new tab). Instead this fetches a resolved
 * `{ url }` from `GET /telephony/calls/:id/recording` — R2-stored copy
 * preferred, provider url fallback, resolved server-side — and feeds it to a
 * plain `<audio>` element's `src`. That extra round-trip is required rather
 * than pointing `<audio>` straight at the route: an `<audio>` element can't
 * attach an Authorization header, so the URL has to be resolved through an
 * authenticated fetch (marketingApi, same as every other call) first.
 *
 * Self-contained: mount it wherever a call has a recording (the `hasRecording`
 * gate lives in the caller, same convention as CallAnalysisPanel).
 *
 * ## A 404 and a 500 are not the same screen
 *
 * This component used to answer `if (isError || !data?.url) return null` —
 * every failure rendered as the same silence. A 404 genuinely means "this call
 * has no recording" and silence is the honest answer to it. A 500, an expired
 * provider token or a dropped connection mean "we do not know", and rendering
 * them as absence told a rep hunting for a call they need to hear that it does
 * not exist. The two are separated below, and the second one says so out loud
 * with a retry beside it.
 */
export interface CallRecordingPlayerProps {
  callId: string;
}

/**
 * "The route said this call has no recording", as opposed to any other reason
 * the fetch did not come back.
 *
 * Written as an explicit `=== 404` rather than `!== 404` on purpose: a network
 * failure carries no `response` at all, and the inverted form would classify
 * the single most likely runtime failure as an absent recording.
 *
 * Exported because it is a RULE, not a detail of this component. StreamCallDetail
 * asks the same question of the same query to decide CallAnalysisPanel's
 * `hasRecording`, and it used to re-derive the cast and the comparison inline —
 * two copies of a one-directional check, one of which carried the paragraph
 * explaining the direction. One copy, in the file that documents it.
 */
export function isMissingRecording(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 404;
}

/**
 * "This call is not yours to hear", as opposed to any other reason the fetch
 * did not come back.
 *
 * Same explicit-`=== 403` direction and the same reason: a response-less
 * network failure must not be classified as a permission decision.
 *
 * `SalesCallService.get` — which gates the recording, the analysis and the run
 * — throws Forbidden when a REP asks for a teammate's call. In /calls that is
 * nearly unreachable (the list is already filtered to the rep's own calls), but
 * the person stream reaches it the moment a lead is REASSIGNED: the new owner
 * can read the lead's activity rows, including the calls the previous owner
 * placed. Without this, that row's panel is a red "could not be loaded" with a
 * retry that can never succeed.
 */
export function isForbidden(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 403;
}

/**
 * The recording query, shared.
 *
 * Exported so a second mount point can read the SAME cache entry — the person
 * stream needs to know whether a recording exists (it is CallAnalysisPanel's
 * `hasRecording` precondition) and must not pay a second request to find out.
 * One `queryKey`, one `queryFn`, one round-trip however many readers there are.
 */
export function useCallRecording(callId: string): UseQueryResult<CallRecordingResult> {
  return useQuery({
    queryKey: ['marketing', 'calls', callId, 'recording'],
    queryFn: () => getCallRecording(callId),
    retry: false,
  });
}

export default function CallRecordingPlayer({ callId }: CallRecordingPlayerProps) {
  const { t } = useTranslation('marketing');

  const { data, isLoading, isError, error, refetch, isFetching } = useCallRecording(callId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-1 text-caption text-muted-foreground">
        <Spinner className="h-4 w-4" /> {t('callRecording.loading', 'Loading recording…')}
      </div>
    );
  }

  // The route said there is none. Nothing to show, and nothing went wrong —
  // CallAnalysisPanel carries the "recording required" hint elsewhere on the
  // row, so this component stays silent.
  if (isError && isMissingRecording(error)) return null;

  // Anything else: we do not know whether this call has a recording. Say so.
  if (isError || !data?.url) {
    return (
      <div
        role="alert"
        data-testid={`call-recording-failed-${callId}`}
        className="flex flex-wrap items-center gap-2 py-1 text-caption text-danger"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('callRecording.failed', 'Recording could not be loaded')}</span>
        <Button variant="ghost" size="sm" onClick={() => refetch()} loading={isFetching}>
          {t('callRecording.retry', 'Try again')}
        </Button>
      </div>
    );
  }

  return (
    <div className="py-1">
      <p className="mb-1 text-caption font-medium text-foreground">
        {t('callRecording.title', 'Recording')}
      </p>
      <audio controls preload="none" className="h-9 w-full max-w-md" src={data.url}>
        {t('callRecording.unavailable', 'Recording is not available for this call.')}
      </audio>
    </div>
  );
}
