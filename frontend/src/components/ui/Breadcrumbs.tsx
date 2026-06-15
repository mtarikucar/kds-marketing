import { ChevronRight } from 'lucide-react';
import { cn } from './cn';

/**
 * Generic Breadcrumbs component for the Console design system.
 * Renders a `<nav aria-label="Breadcrumb">` with an ordered list.
 * The last item receives `aria-current="page"`.
 *
 * NOTE: A separate Breadcrumbs also exists under features/marketing/components/
 * for the existing marketing pages — this one is the new generic UI primitive.
 */
export interface BreadcrumbItem {
  label: string;
  /** If omitted, the item renders as plain text (useful for the current page). */
  href?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex', className)}>
      <ol className="inline-flex items-center gap-1.5 text-sm">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={index} className="inline-flex items-center gap-1.5">
              {isLast ? (
                <span
                  aria-current="page"
                  className="font-medium text-foreground"
                >
                  {item.label}
                </span>
              ) : (
                <>
                  {item.href ? (
                    <a
                      href={item.href}
                      className={cn(
                        'text-muted-foreground hover:text-foreground transition-colors duration-fast',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring] rounded',
                      )}
                    >
                      {item.label}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">{item.label}</span>
                  )}
                  <ChevronRight
                    className="h-3.5 w-3.5 text-muted-foreground shrink-0"
                    aria-hidden="true"
                  />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
