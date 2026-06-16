import { cn } from './cn';
import { Breadcrumbs } from './Breadcrumbs';
import type { BreadcrumbItem, BreadcrumbsProps } from './Breadcrumbs';

export interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: BreadcrumbItem[];
  /** Optional render-prop forwarded to Breadcrumbs for SPA client-side nav. */
  renderBreadcrumbLink?: BreadcrumbsProps['renderLink'];
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, breadcrumbs, renderBreadcrumbLink, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumbs items={breadcrumbs} renderLink={renderBreadcrumbLink} />
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-h1 text-foreground truncate">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
