import { Monitor, Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useThemeStore, type ThemePref } from '@/lib/theme';
import { cn } from './cn';

const OPTIONS: {
  value: ThemePref;
  labelKey: 'kit.theme.system' | 'kit.theme.light' | 'kit.theme.dark';
  Icon: typeof Sun;
}[] = [
  { value: 'system', labelKey: 'kit.theme.system', Icon: Monitor },
  { value: 'light', labelKey: 'kit.theme.light', Icon: Sun },
  { value: 'dark', labelKey: 'kit.theme.dark', Icon: Moon },
];

export function ThemeToggle() {
  const { t } = useTranslation();
  const { pref, setPref } = useThemeStore();
  return (
    <div role="group" aria-label={t('kit.theme.label')} className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5">
      {OPTIONS.map(({ value, labelKey, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={t(labelKey)}
          aria-pressed={pref === value}
          onClick={() => setPref(value)}
          className={cn(
            'inline-flex h-7 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pref === value && 'bg-surface text-foreground shadow-xs',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
