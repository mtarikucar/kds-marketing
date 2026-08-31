import { useTranslation } from 'react-i18next';
import CallRecordingPlayer, {
  useCallRecording,
} from '../../../pages/marketing/calls/CallRecordingPlayer';
import CallAnalysisPanel from '../../../pages/marketing/calls/CallAnalysisPanel';

/**
 * What a logged call opens into, inside the person's stream.
 *
 * ## Why it exists
 *
 * A call row in the stream used to be a dead end. It could say "Sales call:
 * CONNECTED · 3 dk" and no more, because the recording and the AI analysis
 * both hang off a `SalesCall.id` that the mirrored `LeadActivity` never kept.
 * Hearing the call you had just read about meant leaving the person, opening
 * /calls, and finding the row again by phone number and timestamp. The id now
 * rides on the stream item (`callId`, derived from `LeadActivity.metadata` —
 * see call-activity.ts), and this component is where it gets used.
 *
 * ## Why it reuses rather than reimplements
 *
 * `CallRecordingPlayer` and `CallAnalysisPanel` already know how to render a
 * call's audio and its analysis, including the run-on-demand button and every
 * failure state. Both were written self-contained ("drop it under a call row
 * given the callId") and neither assumes the calls table's chrome, so the
 * adaptation needed here is a wrapper, not a fork. Two components rendering
 * one call two different ways is the same mistake one layer up that the merged
 * stream exists to remove.
 *
 * ## The one thing this wrapper decides: `hasRecording`
 *
 * `CallAnalysisPanel` needs to know whether audio exists — with none, it shows
 * "a recording is required to analyse" instead of the Analyse button. The
 * calls table answers that from `SalesCall.recordingUrl`, a column the stream
 * does not carry. So it is read off the recording query itself, which is a
 * strictly better answer (the resolve route prefers the R2 copy, which the
 * provider column does not know about) and costs nothing: `useCallRecording`
 * is the same `queryKey` and `queryFn` the player mounts, so React Query
 * serves both from ONE round-trip.
 *
 * It is answered only once that query has SETTLED. Rendering the panel while
 * the recording is still in flight would flash a claim about audio nobody has
 * looked for yet; and on a hard failure (a 500, an expired token, the network)
 * the honest value is `true` — "we do not know, let the server decide when you
 * press Analyse" — never `false`, which would state as fact that this call has
 * no recording. That is the same lie the player itself used to tell by
 * rendering an error as silence.
 */
export interface StreamCallDetailProps {
  /** The `SalesCall` this stream row mirrors. Callers must not mount this for a
   *  row without one — a legacy call has no id and nothing to fetch. */
  callId: string;
  /** The stream row's id, so the panel can be addressed per record. */
  itemId: string;
}

export default function StreamCallDetail({ callId, itemId }: StreamCallDetailProps) {
  const { t } = useTranslation('marketing');
  const recording = useCallRecording(callId);

  // `isPending` is "no answer yet either way". A 404 has ANSWERED — there is no
  // recording — so it falls through to the panel with hasRecording false.
  const settled = !recording.isPending;
  const knownAbsent = recording.isError && !!recording.error &&
    (recording.error as { response?: { status?: number } }).response?.status === 404;

  return (
    <div
      data-testid={`stream-call-detail-${itemId}`}
      className="mt-1.5 rounded-lg border border-border bg-surface-muted/40 px-3 py-1.5"
    >
      <CallRecordingPlayer callId={callId} />
      {settled && (
        <>
          <p className="mt-1 text-caption font-medium text-foreground">
            {t('leadDetail.stream.callAnalysis', 'Arama analizi')}
          </p>
          <CallAnalysisPanel callId={callId} hasRecording={!knownAbsent} />
        </>
      )}
    </div>
  );
}
