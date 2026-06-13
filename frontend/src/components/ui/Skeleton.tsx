import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** Loading placeholder for perceived performance (replaces ad-hoc spinners). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} {...props} />;
}
