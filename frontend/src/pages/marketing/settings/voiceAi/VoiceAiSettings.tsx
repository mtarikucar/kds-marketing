import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Clipboard, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  getVoiceAiStatus,
  type VoiceAiStatus,
} from '../../../../features/marketing/api/voice-ai.service';
import { PageHeader, Card, CardContent, Badge, Button, Spinner } from '../../../../components/ui';

/**
 * VoiceAiSettings — read-only operator surface for the inert Voice-AI features.
 * Calls GET /marketing/voice-ai/status and renders each capability (STT, Bridge,
 * NetGSM IVR, Copilot) as an on/off row, with the copy-able public URL templates
 * and a short Turkish note on what NetGSM add-on / key each one needs. Everything
 * here activates automatically once the operator buys the add-on and sets the
 * env key — this page just shows the current state and the wiring URLs.
 */

type CapabilityKey = keyof VoiceAiStatus['capabilities'];

interface CapabilityRow {
  key: CapabilityKey;
  /** Optional URL template from the status payload to surface + copy. */
  urlKey?: keyof VoiceAiStatus['urls'];
}

const ROWS: CapabilityRow[] = [
  { key: 'stt' },
  { key: 'bridge', urlKey: 'bridge' },
  { key: 'netgsmIvr', urlKey: 'netgsmIvr' },
  { key: 'copilot', urlKey: 'copilotSuggest' },
];

export default function VoiceAiSettings() {
  const { t } = useTranslation('marketing');

  const { data, isLoading } = useQuery<VoiceAiStatus>({
    queryKey: ['marketing', 'voice-ai', 'status'],
    queryFn: getVoiceAiStatus,
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('common.copied', 'Kopyalandı'));
    } catch {
      toast.error(t('common.copyFailed', 'Kopyalanamadı'));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('voiceAiSettings.title', 'Sesli AI')}
        description={t(
          'voiceAiSettings.subtitle',
          'Sesli AI yetenekleri NetGSM eklentilerini satın alıp anahtarları girdiğinizde otomatik olarak aktifleşir. Aşağıda her yeteneğin durumu ve bağlantı adresleri yer alır.',
        )}
      />

      {isLoading ? (
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <Spinner className="h-4 w-4" /> {t('common.loading', 'Yükleniyor…')}
        </div>
      ) : !data ? (
        <Card>
          <CardContent className="p-5 text-caption text-muted-foreground">
            {t('voiceAiSettings.unavailable', 'Durum bilgisi alınamadı.')}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {ROWS.map((row) => {
              const on = data.capabilities[row.key];
              const url = row.urlKey ? data.urls[row.urlKey] : undefined;
              return (
                <div key={row.key} className="space-y-2 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        {on ? (
                          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        )}
                        {t(`voiceAiSettings.capability.${row.key}.name`, row.key)}
                      </p>
                      <p className="mt-0.5 text-caption text-muted-foreground">
                        {t(
                          `voiceAiSettings.capability.${row.key}.note`,
                          '',
                        )}
                      </p>
                    </div>
                    <Badge tone={on ? 'success' : 'neutral'}>
                      {on ? t('voiceAiSettings.on', 'Açık') : t('voiceAiSettings.off', 'Kapalı')}
                    </Badge>
                  </div>

                  {url && (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 break-all rounded border border-border bg-surface-muted px-2 py-1.5 text-xs text-muted-foreground">
                        {url}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('common.copy', 'Kopyala')}
                        onClick={() => copy(url)}
                      >
                        <Clipboard className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
