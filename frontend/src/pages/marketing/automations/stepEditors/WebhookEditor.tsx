import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import type { StepEditorProps } from './types';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Visual editor for `http_webhook_out`: URL, method, and a JSON body. */
export function WebhookEditor({ step, onPatch }: StepEditorProps) {
  const { t } = useTranslation('marketing');
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
        <div className="text-caption text-muted-foreground mb-1">{t('automations.webhookMethod', 'Method')}</div>
        <Select value={(step.method as string) ?? 'POST'} onValueChange={(v) => onPatch({ method: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <div className="text-caption text-muted-foreground mb-1">{t('automations.webhookBody', 'Body (JSON)')}</div>
        <Textarea
          className="font-mono min-h-20"
          value={(step.body as string) ?? ''}
          onChange={(e) => onPatch({ body: e.target.value })}
        />
      </div>
    </div>
  );
}
