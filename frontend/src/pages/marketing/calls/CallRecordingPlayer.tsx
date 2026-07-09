import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getCallRecording } from '../../../features/marketing/api/voice-ai.service';
import { Spinner } from '../../../components/ui';

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
 * gate lives in the caller, same convention as CallAnalysisPanel) — renders
 * nothing once loaded if the route 404s (no recording yet), so a call with no
 * playable recording never leaves a dead widget on screen.
 */
export interface CallRecordingPlayerProps {
  callId: string;
}

export default function CallRecordingPlayer({ callId }: CallRecordingPlayerProps) {
  const { t } = useTranslation('marketing');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['marketing', 'calls', callId, 'recording'],
    queryFn: () => getCallRecording(callId),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-1 text-caption text-muted-foreground">
        <Spinner className="h-4 w-4" /> {t('callRecording.loading', 'Loading recording…')}
      </div>
    );
  }

  // 404 (no storage key + no provider url) or an unexpected error — no
  // player to show. CallAnalysisPanel already surfaces a "recording
  // required" hint elsewhere on the row; this component just stays silent.
  if (isError || !data?.url) {
    return null;
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
