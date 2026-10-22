import { useTranslation } from 'react-i18next';
import { cn } from '@/components/ui';

/** The product mark: the brand navy square and the name. */
export function Brand({ suffix, className }: { suffix?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-navy font-display text-sm font-bold text-brand-navy-foreground"
      >
        {t('app.name').charAt(0)}
      </span>
      <span className="font-display text-h3 text-foreground">{t('app.name')}</span>
      {suffix && <span className="text-caption text-muted-foreground">{suffix}</span>}
    </span>
  );
}
