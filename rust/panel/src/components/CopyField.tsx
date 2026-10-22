import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input, toast } from '@/components/ui';
import { copyText } from '@/lib/clipboard';

/** A read-only value with a copy button; the field selects itself on focus for manual copy. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const onCopy = async () => {
    if (await copyText(value)) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        aria-label={label}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-caption"
        spellCheck={false}
      />
      <Button type="button" variant="outline" onClick={() => void onCopy()}>
        <Copy className="h-4 w-4" aria-hidden="true" />
        {t('common.copy')}
      </Button>
    </div>
  );
}
