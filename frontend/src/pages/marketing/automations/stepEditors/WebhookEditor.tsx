import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import type { StepEditorProps } from './types';

/**
 * Visual editor for `http_webhook_out`. The runtime (workflow-action.handler.ts)
 * always POSTs `JSON.stringify({ payload, lead, trigger })` to the URL — the
 * method is fixed and the lead+trigger context is attached automatically — and it
 * reads `step.payload` (NOT `step.body`). So this edits the URL and the `payload`
 * JSON only. (The old editor wrote `method`/`body`, neither of which the runtime
 * reads, so the configured body was silently never sent.)
 */
export function WebhookEditor({ step, onPatch }: StepEditorProps) {
  const { t } = useTranslation('marketing');
  const [draft, setDraft] = useState(() =>
    step.payload === undefined || step.payload === null ? '' : JSON.stringify(step.payload, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  const onPayloadChange = (text: string) => {
    setDraft(text);
    if (text.trim() === '') {
      setError(null);
      onPatch({ payload: null });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setError(null);
      onPatch({ payload: parsed });
    } catch {
      // Invalid JSON: surface it and do NOT apply, so a half-typed payload can't
      // be saved as a broken value.
      setError(t('automations.invalidJson', 'Invalid JSON.'));
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-caption text-muted-foreground mb-1">{t('automations.webhookUrl', 'URL')}</div>
        <Input
          value={(step.url as string) ?? ''}
          placeholder="https://example.com/hook"
          onChange={(e) => onPatch({ url: e.target.value })}
        />
      </div>
      <div>
        <div className="text-caption text-muted-foreground mb-1">
          {t('automations.webhookPayload', 'Payload (JSON)')}
        </div>
        <Textarea
          className="font-mono min-h-20"
          aria-label={t('automations.webhookPayload', 'Payload (JSON)')}
          aria-invalid={!!error}
          value={draft}
          placeholder='{ "event": "lead_qualified" }'
          onChange={(e) => onPayloadChange(e.target.value)}
        />
        {error && <p className="text-[11px] text-danger mt-1">{error}</p>}
        <p className="text-[11px] text-muted-foreground mt-1">
          {t(
            'automations.webhookHint',
            'POSTed as { payload, lead, trigger } — the lead & trigger are attached automatically.',
          )}
        </p>
      </div>
    </div>
  );
}
