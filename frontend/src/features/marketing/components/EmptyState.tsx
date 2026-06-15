import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * Shared dashed-card empty state: tells the user what a page is for and what to
 * do next, instead of a bare "No data". A superset of the text-only empties
 * already used across the app — pass only `title` for the legacy look.
 */
export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="bg-surface rounded-xl border border-dashed border-border p-8 text-center">
      {icon && <div className="mx-auto mb-3 w-10 h-10 text-muted-foreground">{icon}</div>}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
