import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';

/**
 * Generic Breadcrumbs component for the Console design system.
 * Renders a `<nav aria-label="Breadcrumb">` with an ordered list.
 * The last item receives `aria-current="page"`.
 *
 * NOTE: A separate Breadcrumbs also exists under features/marketing/components/
 * for the existing marketing pages — this one is the new generic UI primitive.
 *
 * ### SPA navigation
 * Pass a `renderLink` prop to swap the default `<a href>` for a client-side
 * router link (e.g. react-router-dom `Link`). The render prop receives the
 * item and the inner children so the caller controls the element:
 *
 * ```tsx
 * import { Link } from 'react-router-dom';
 * <Breadcrumbs
 *   items={items}
 *   renderLink={(item, children) => (
 *     <Link to={item.href!} className="...">{children}</Link>
 *   )}
 * />
 * ```
 */
export interface BreadcrumbItem {
  label: string;
  /** If omitted, the item renders as plain text (useful for the current page). */
  href?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
  /**
   * Optional render-prop for SPA link navigation. When provided, non-last
   * items that have an `href` use this renderer instead of a plain `<a>`.
   * The prop receives the item object and the child ReactNode (the label text)
   * so the caller can wrap it in a router Link with proper styling.
   */
  renderLink?: (item: BreadcrumbItem, children: ReactNode) => ReactNode;
}

const linkClassName = cn(
  'text-muted-foreground hover:text-foreground transition-colors duration-fast',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring] rounded',
);

export function Breadcrumbs({ items, className, renderLink }: BreadcrumbsProps) {
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
                    renderLink ? (
                      renderLink(item, <span className={linkClassName}>{item.label}</span>)
                    ) : (
                      <a
                        href={item.href}
                        className={linkClassName}
                      >
                        {item.label}
                      </a>
                    )
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
