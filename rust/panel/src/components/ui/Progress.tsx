import { cn } from './cn';

export type ProgressTone = 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface ProgressProps {
  value: number;
  tone?: ProgressTone;
  className?: string;
}

const trackClasses = 'w-full overflow-hidden rounded-full bg-surface-muted';

const fillToneClasses: Record<ProgressTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export function Progress({ value, tone = 'primary', className }: ProgressProps) {
  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={clampedValue}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-2', trackClasses, className)}
    >
      <div
        className={cn('h-full rounded-full transition-all duration-base', fillToneClasses[tone])}
        style={{ width: `${clampedValue}%` }}
      />
    </div>
  );
}
