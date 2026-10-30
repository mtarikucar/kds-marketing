import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Textarea, toast } from '@/components/ui';
import { copyText } from '@/lib/clipboard';

/**
 * A read-only value with a copy button; the field selects itself on focus for manual copy. A
 * `multiline` value (a configuration file) shows in a text area of its own height.
 */
export function CopyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const { t } = useTranslation();
  const onCopy = async () => {
    if (await copyText(value)) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  };
  const field = {
    readOnly: true,
    'aria-label': label,
    value,
    spellCheck: false,
    className: 'font-mono text-caption',
  };
  return (
    <div className={multiline ? 'flex items-start gap-2' : 'flex items-center gap-2'}>
      {multiline ? (
        <Textarea
          {...field}
          rows={value.trimEnd().split('\n').length}
          onFocus={(e) => e.currentTarget.select()}
          className={`${field.className} min-h-0 resize-none`}
        />
      ) : (
        <Input {...field} onFocus={(e) => e.currentTarget.select()} />
      )}
      <Button type="button" variant="outline" onClick={() => void onCopy()}>
        <Copy className="h-4 w-4" aria-hidden="true" />
        {t('common.copy')}
      </Button>
    </div>
  );
}
