import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** Loading placeholder; animate-pulse shimmer using surface-muted token. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="presentation"
      className={cn('animate-pulse rounded-md bg-surface-muted', className)}
      {...props}
    />
  );
}
