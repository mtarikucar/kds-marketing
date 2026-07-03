import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Check } from 'lucide-react';
import { IconButton } from '@/components/ui';

/** A read-only value (webhook URL, embed snippet, bridge URL) with copy-to-clipboard. */
export function CopyField({
  value,
  label,
  multiline,
}: {
  value: string;
  label?: string;
  multiline?: boolean;
}) {
  const { t } = useTranslation('marketing');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t('common.copied', 'Copied'));
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('common.copyFailed', 'Could not copy'));
    }
  };

  return (
    <div className="space-y-1">
      {label && <p className="text-caption text-muted-foreground">{label}</p>}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-2">
        <code
          className={`min-w-0 flex-1 text-xs text-foreground ${multiline ? 'whitespace-pre-wrap break-all' : 'truncate'}`}
        >
          {value}
        </code>
        <IconButton
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={copy}
          aria-label={t('common.copy', 'Copy')}
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </div>
  );
}
