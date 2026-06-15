import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * Styled table primitives for the Console design system.
 *
 * Thin wrappers over the native table elements that apply the token-based
 * styling once, so callers compose semantic markup (`<Table><THead>…`) instead
 * of repeating Tailwind strings. `DataTable` builds on these for the common
 * data-grid case; these primitives stay available for bespoke layouts.
 *
 * `TH`/`TD` accept a `numeric` prop that right-aligns the cell and switches to
 * tabular figures — the correct treatment for money/quantity columns.
 */

export const Table = forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
  ),
);
Table.displayName = 'Table';

export const THead = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn('bg-surface-muted text-micro uppercase text-muted-foreground', className)}
    {...props}
  />
));
THead.displayName = 'THead';

export const TBody = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <tbody ref={ref} className={cn(className)} {...props} />);
TBody.displayName = 'TBody';

export const TR = forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn('border-b border-border hover:bg-surface-muted/50', className)}
      {...props}
    />
  ),
);
TR.displayName = 'TR';

export interface THProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Right-align with tabular figures — for numeric columns. */
  numeric?: boolean;
}

export const TH = forwardRef<HTMLTableCellElement, THProps>(
  ({ className, numeric, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-10 px-3 text-start align-middle font-medium',
        numeric && 'text-end tabular-nums',
        className,
      )}
      {...props}
    />
  ),
);
TH.displayName = 'TH';

export interface TDProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Right-align with tabular figures — for numeric columns. */
  numeric?: boolean;
}

export const TD = forwardRef<HTMLTableCellElement, TDProps>(
  ({ className, numeric, ...props }, ref) => (
    <td
      ref={ref}
      className={cn('px-3 py-2.5 align-middle', numeric && 'text-end tabular-nums', className)}
      {...props}
    />
  ),
);
TD.displayName = 'TD';
