import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/**
 * Shared page header: bold title, an optional one-line subtitle that says what
 * the page is for, and an optional primary action on the right. Matches the
 * hand-rolled pattern the AI pages already use, so swapping it in is a
 * no-visual-change refactor and stops header drift across the console.
 */
export default function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
