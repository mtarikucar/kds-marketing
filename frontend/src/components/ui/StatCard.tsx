import type { ReactNode } from 'react';
import { cn } from './cn';

export type StatCardTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface StatCardDelta {
  value: string;
  direction: 'up' | 'down' | 'flat';
}

export interface StatCardProps {
  label: string;
  value: string;
  icon?: ReactNode;
  delta?: StatCardDelta;
  tone?: StatCardTone;
  className?: string;
}

const deltaColorClasses: Record<StatCardDelta['direction'], string> = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted-foreground',
};

const deltaArrow: Record<StatCardDelta['direction'], string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

export function StatCard({ label, value, icon, delta, tone = 'neutral', className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface p-5 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-micro uppercase tracking-wide text-muted-foreground font-medium truncate">
            {label}
          </p>
          <p className="font-display text-h1 tabular-nums text-foreground leading-none">
            {value}
          </p>
        </div>
        {icon && (
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>

      {delta && (
        <div
          className={cn(
            'mt-3 flex items-center gap-1 text-sm font-medium',
            deltaColorClasses[delta.direction],
          )}
          data-direction={delta.direction}
        >
          <span aria-hidden="true">{deltaArrow[delta.direction]}</span>
          <span>{delta.value}</span>
        </div>
      )}
    </div>
  );
}
