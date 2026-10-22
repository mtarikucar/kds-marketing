import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';

export interface CalloutProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CalloutTone;
  icon?: ReactNode;
  title?: string;
  children?: ReactNode;
}

// Subtle tinted surface + colored accent border; body text stays `text-foreground`
// for legibility (the `*-foreground` tokens are sized for the SOLID `*` color,
// not the pale/dark `*-subtle` surface). The title carries the vivid tone color.
const toneClasses: Record<CalloutTone, string> = {
  info: 'bg-info-subtle border-info text-foreground',
  success: 'bg-success-subtle border-success text-foreground',
  warning: 'bg-warning-subtle border-warning text-foreground',
  danger: 'bg-danger-subtle border-danger text-foreground',
};

const titleColorClasses: Record<CalloutTone, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function Callout({ tone = 'info', icon, title, children, className, ...props }: CalloutProps) {
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status';

  return (
    <div
      role={role}
      className={cn(
        'flex gap-3 rounded-lg border-s-4 p-4',
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {icon && (
        <span className="mt-0.5 shrink-0" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="flex flex-col gap-1">
        {title && (
          <p className={cn('text-sm font-semibold', titleColorClasses[tone])}>{title}</p>
        )}
        {children && <div className="text-sm">{children}</div>}
      </div>
    </div>
  );
}
