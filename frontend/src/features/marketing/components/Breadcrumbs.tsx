import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { NAV_GROUPS } from '../navigation';

/**
 * Route-derived breadcrumb trail (wayfinding). Reuses the navigation config as
 * the label source, so "where am I" reads consistently with the sidebar:
 * `Group › Page` (and `Group › Page › New/Edit/Detail` on nested routes). The
 * match is the longest nav path that prefixes the current location, so detail
 * routes like `/leads/:id` resolve to their parent ("Leads") plus a leaf.
 */
const ITEMS = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, groupLabel: g.label, groupLabelKey: g.labelKey })),
);

export default function Breadcrumbs() {
  const { t } = useTranslation('marketing');
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, '') || '/';

  const match = ITEMS.filter(
    (i) => path === i.path || path.startsWith(i.path + '/'),
  ).sort((a, b) => b.path.length - a.path.length)[0];

  if (!match) return null;

  const rest = path.slice(match.path.length).split('/').filter(Boolean);
  const leaf = rest[rest.length - 1];
  const subLabel = !leaf
    ? null
    : leaf === 'new'
      ? t('breadcrumb.new', 'New')
      : leaf === 'edit'
        ? t('breadcrumb.edit', 'Edit')
        : t('breadcrumb.detail', 'Detail');

  const Chevron = () => <ChevronRightIcon className="h-4 w-4 shrink-0 text-slate-300" />;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="hidden truncate text-slate-400 sm:inline">
        {t(match.groupLabelKey, match.groupLabel)}
      </span>
      <span className="hidden sm:inline">
        <Chevron />
      </span>
      {subLabel ? (
        <>
          <Link
            to={match.path}
            className="truncate text-slate-500 transition-colors hover:text-slate-800"
          >
            {t(match.labelKey, match.label)}
          </Link>
          <Chevron />
          <span className="truncate font-medium text-slate-900">{subLabel}</span>
        </>
      ) : (
        <span className="truncate font-medium text-slate-900">
          {t(match.labelKey, match.label)}
        </span>
      )}
    </nav>
  );
}
