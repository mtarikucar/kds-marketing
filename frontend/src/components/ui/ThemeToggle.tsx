import { Monitor, Sun, Moon } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import type { ThemePref } from '@/lib/theme';
import { cn } from './cn';

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle() {
  const { pref, setPref } = useThemeStore();
  return (
    <div role="group" aria-label="Theme" className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
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
