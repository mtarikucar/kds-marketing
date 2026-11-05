import { useTranslation } from 'react-i18next';
import { cn } from '@/components/ui';

/** The Jeeta mark and product name. */
export function Brand({ suffix, className }: { suffix?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <img src="/brand/jeeta-mark.png" alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
      <span className="font-display text-base font-semibold tracking-tight text-foreground">{t('app.name')}</span>
      {suffix && <span className="text-caption text-muted-foreground">{suffix}</span>}
    </span>
  );
}
