import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Mic, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { CopyField } from './CopyField';

interface VoiceAiStatus {
  capabilities: { stt: boolean; bridge: boolean; netgsmIvr: boolean; copilot: boolean };
  urls: { bridge: string; netgsmIvr: string };
}

/**
 * AI Voice — let an external voice agent (ElevenLabs / VAPI / Retell) answer calls
 * using the CRM's AI as its brain, or drive the NetGSM IVR. This card surfaces the
 * wiring URLs to paste into the voice partner + the platform readiness flags. The
 * per-workspace/SIP provisioning is operator-side; the code seam is the bridge URL.
 */
export function VoiceAiCard() {
  const { t } = useTranslation('marketing');
  const { data, isLoading, isError } = useQuery<VoiceAiStatus>({
    queryKey: ['marketing', 'voice-ai', 'status'],
    queryFn: () => marketingApi.get('/voice-ai/status').then((r) => r.data),
  });

  const caps = data?.capabilities;
  const anyOn = !!(caps?.bridge || caps?.netgsmIvr);

  const flag = (on: boolean | undefined) => {
    if (isLoading) return <Skeleton className="h-4 w-20" />;
    return on ? (
      <span className="flex items-center gap-1 text-caption text-success">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('accounts.voice.on', 'Ready')}
      </span>
    ) : (
      <span className="flex items-center gap-1 text-caption text-warning">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {t('accounts.voice.needsEnv', 'Needs server key')}
      </span>
    );
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted" style={{ color: '#7C3AED' }}>
              <Mic className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-medium text-foreground">{t('accounts.voice.title', 'AI Voice')}</p>
              <p className="text-caption text-muted-foreground">
                {t('accounts.voice.subtitle', 'An AI voice agent answers calls using your CRM AI')}
              </p>
            </div>
          </div>
          {isLoading ? (
            <Skeleton className="h-5 w-20 rounded-full" />
          ) : (
            <Badge tone={anyOn ? 'success' : 'neutral'} size="sm">
              {anyOn ? t('accounts.voice.available', 'Available') : t('accounts.notConnected', 'Not connected')}
            </Badge>
          )}
        </div>

        {isError && (
          <p className="text-caption text-muted-foreground">
            {t('accounts.voice.statusError', "Couldn't load status")}
          </p>
        )}

        <p className="text-caption text-muted-foreground">
          {t('accounts.voice.explain', 'Point an ElevenLabs / VAPI / Retell voice agent at the bridge URL below as its “Custom LLM”, or route NetGSM calls to the IVR. Your AI agent’s persona + knowledge drive the replies.')}
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground">{t('accounts.voice.bridge', 'AI voice bridge (ElevenLabs / VAPI / Retell)')}</span>
            {flag(caps?.bridge)}
          </div>
          {data?.urls?.bridge && (
            <CopyField
              label={t('accounts.voice.bridgeUrl', 'Custom-LLM bridge URL (replace {channelId} with your Voice channel’s id)')}
              value={data.urls.bridge}
            />
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-sm text-foreground">{t('accounts.voice.ivr', 'NetGSM IVR')}</span>
            {flag(caps?.netgsmIvr)}
          </div>
          {data?.urls?.netgsmIvr && (
            <CopyField
              label={t('accounts.voice.ivrUrl', 'NetGSM IVR webhook URL')}
              value={data.urls.netgsmIvr}
            />
          )}
        </div>

        {!isLoading && !isError && !anyOn && (
          <p className="text-caption text-muted-foreground">
            {t('accounts.voice.opsNote', 'An admin must set VOICE_AI_BRIDGE_SECRET (and, for calls, provision the NetGSM SIP-trunk / AI add-on) before these go live.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
