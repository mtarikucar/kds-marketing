import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles, AlarmClock } from 'lucide-react';
import { toast } from 'sonner';
import {
  getCallAnalysis,
  runCallAnalysis,
  isCallAnalysis,
  type CallSentiment,
} from '../../../features/marketing/api/voice-ai.service';
import { Badge, type BadgeProps, Button, Spinner } from '../../../components/ui';

/**
 * CallAnalysisPanel — post-call AI analysis for a single SalesCall. Fetches the
 * persisted CallAnalysis (recording → STT → Claude, run server-side). Renders
 * the summary, a sentiment chip, the score, action items and topic chips. When
 * no analysis exists yet (`{status:'NONE'}`) it offers an "Analiz et" button
 * that triggers the run endpoint and refetches; if there's no recording it
 * shows a subtle "recording required" hint instead (analysis needs audio).
 *
 * Self-contained: drop it under a call row given the callId + whether the call
 * has a recording URL.
 */
export interface CallAnalysisPanelProps {
  callId: string;
  hasRecording: boolean;
}

const SENTIMENT_TONE: Record<CallSentiment, BadgeProps['tone']> = {
  POSITIVE: 'success',
  NEUTRAL: 'neutral',
  NEGATIVE: 'danger',
};

export default function CallAnalysisPanel({ callId, hasRecording }: CallAnalysisPanelProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const queryKey = ['marketing', 'calls', callId, 'analysis'];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getCallAnalysis(callId),
  });

  const run = useMutation({
    mutationFn: () => runCallAnalysis(callId),
    onSuccess: (res) => {
      if (res.status === 'OK') {
        toast.success(t('callAnalysis.runOk', 'Analysis complete'));
        qc.invalidateQueries({ queryKey });
      } else if (res.status === 'SKIPPED') {
        toast.message(t('callAnalysis.runSkipped', 'Analysis already exists'));
        qc.invalidateQueries({ queryKey });
      } else {
        toast.error(
          res.reason
            ? `${t('callAnalysis.runFailed', 'Analysis failed')}: ${res.reason}`
            : t('callAnalysis.runFailed', 'Analysis failed'),
        );
      }
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('callAnalysis.runFailed', 'Analysis failed')),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-caption text-muted-foreground">
        <Spinner className="h-4 w-4" /> {t('common.loading', 'Loading…')}
      </div>
    );
  }

  // No analysis yet → either prompt to run, or hint that a recording is needed.
  if (!isCallAnalysis(data)) {
    if (!hasRecording) {
      return (
        <p className="inline-flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
          <AlarmClock className="h-3.5 w-3.5" aria-hidden="true" />
          {t('callAnalysis.recordingRequired', 'A call recording is required to analyse')}
        </p>
      );
    }
    return (
      <div className="py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => run.mutate()}
          loading={run.isPending}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {t('callAnalysis.analyse', 'Analyse')}
        </Button>
      </div>
    );
  }

  const a = data;

  return (
    <div className="space-y-4 py-2">
      {/* Header: sentiment + score */}
      <div className="flex flex-wrap items-center gap-2">
        {a.sentiment && (
          <Badge tone={SENTIMENT_TONE[a.sentiment] ?? 'neutral'}>
            {t(`callAnalysis.sentiment.${a.sentiment}`, a.sentiment)}
          </Badge>
        )}
        {a.score != null && (
          <Badge tone="primary">
            {t('callAnalysis.score', 'Score')}: {a.score}/100
          </Badge>
        )}
        {a.sttProvider && (
          <span className="text-micro text-muted-foreground">{a.sttProvider}</span>
        )}
      </div>

      {/* Summary */}
      {a.summary && (
        <div>
          <p className="text-caption font-medium text-foreground">
            {t('callAnalysis.summary', 'Summary')}
          </p>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{a.summary}</p>
        </div>
      )}

      {/* Action items */}
      {a.actionItems && a.actionItems.length > 0 && (
        <div>
          <p className="text-caption font-medium text-foreground">
            {t('callAnalysis.actionItems', 'Action items')}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {a.actionItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Topics */}
      {a.topics && a.topics.length > 0 && (
        <div>
          <p className="text-caption font-medium text-foreground">
            {t('callAnalysis.topics', 'Topics')}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {a.topics.map((topic, i) => (
              <Badge key={i} tone="neutral" size="sm">
                {topic}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
