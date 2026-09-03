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
  /**
   * This page is a TAB inside another one, which already carries the title.
   *
   * Renders the actions alone, right-aligned, and drops the heading. The
   * alternative — the pattern this replaces — was for the embedding page to
   * wrap the whole header in `{!embedded && …}`, which also threw away the
   * primary action: "New segment", "Invite member", "Add endpoint". On a page
   * with an empty state carrying its own create button that is invisible until
   * the first row exists, and then there is no way to add a second.
   *
   * A tab still needs one <h1> on the page and it belongs to the shell, so the
   * heading is genuinely redundant here. The button is not.
   */
  embedded?: boolean;
  className?: string;
}

export function PageHeader({
  title, description, breadcrumbs, renderBreadcrumbLink, actions, embedded, className,
}: PageHeaderProps) {
  if (embedded) {
    // Only the <h1> is redundant — the shell above already says what page this
    // is. The description is not: it routinely carries the one operational fact
    // the page depends on ("each delivery is signed with the endpoint secret",
    // "inert until an operator enables an ESP"), and dropping it to save a line
    // would be deleting content, not de-duplicating it.
    if (!actions && !description) return null;
    return (
      <div
        className={cn(
          'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
          className,
        )}
      >
        {description
          ? <p className="min-w-0 flex-1 text-sm text-muted-foreground">{description}</p>
          : <span className="flex-1" />}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    );
  }
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
