import type { ReactNode } from 'react';
import { cn } from './cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Forwarded to the wrapper so callers can target the state in E2E. */
  'data-testid'?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  'data-testid': testId,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-border p-10 text-center',
        className,
      )}
    >
      {icon && (
        <span className="text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="flex flex-col gap-1">
        <p className="font-display text-h3 text-foreground">{title}</p>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
