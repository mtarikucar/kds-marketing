import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { NAV_HUBS, UNLISTED_DESTINATIONS } from '../navigation';
import { useBreadcrumbStore } from '../hooks/useBreadcrumbLabel';

/**
 * Route-derived breadcrumb trail (wayfinding). Reuses the navigation hub config
 * as the label source, so "where am I" reads consistently with the sidebar:
 * `Hub › Page` (and `Hub › Page › New/Edit/Detail` on nested routes). The match
 * is the longest nav path that prefixes the current location, so detail routes
 * like `/leads/:id` resolve to their parent ("Leads") plus a leaf. Single-page
 * hubs (Dashboard/Tasks) render just their own label.
 */
const ITEMS = NAV_HUBS.flatMap((h) => {
  // One entry per DOOR, not per item: an alias (`/inbox` → the `/leads` item)
  // opens the same page and earns the same trail. Without it, arriving on a
  // bookmarked alias renders no breadcrumb at all — the one page in the console
  // that cannot say where it is.
  const items = (h.children ?? []).flatMap((c) =>
    [c.path, ...(c.aliases ?? [])].map((path) => ({
      path,
      label: c.label,
      labelKey: c.labelKey,
      groupLabel: h.label,
      groupLabelKey: h.labelKey,
    })),
  );
  if (h.path) {
    // single-page hub — the hub itself is the leaf (no distinct group)
    items.push({
      path: h.path,
      label: h.label,
      labelKey: h.labelKey,
      groupLabel: h.label,
      groupLabelKey: h.labelKey,
    });
  }
  return items;
});

/**
 * The UNLISTED destinations, which have no hub and therefore no group segment
 * (`groupLabelKey === labelKey` suppresses it, the same way a single-page hub
 * avoids "Dashboard › Dashboard").
 *
 * They joined the trail on 2026-09-01, when six pages left the Inbox menu and
 * stayed routes. Built from hubs alone this component renders NOTHING on a
 * page it cannot place — the one state it reserves for "I do not know where
 * you are" — so a page that was deliberately unlisted would silently have
 * become a page unable to say its own name. That is a worse loss than the menu
 * entry it gave up, and it applies just as well to /dashboard and /help, which
 * had gone without a trail since they were unlisted.
 *
 * Appended, so a real hub always wins the longest-prefix match if one ever
 * adopts the same path — the same precedence useNavCommands uses.
 */
ITEMS.push(
  ...UNLISTED_DESTINATIONS.map((d) => ({
    path: d.path,
    label: d.label,
    labelKey: d.labelKey,
    groupLabel: d.label,
    groupLabelKey: d.labelKey,
  })),
);

export default function Breadcrumbs() {
  const { t } = useTranslation('marketing');
  const { pathname } = useLocation();
  const detailLabel = useBreadcrumbStore((s) => s.detailLabel);
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
        : // A detail route ("/leads/123"): prefer the record's name if the page
          // supplied one, else fall back to a generic "Detail".
          detailLabel ?? t('breadcrumb.detail', 'Detail');

  // Suppress a redundant "Dashboard › Dashboard" for single-page hubs.
  const showGroup = match.groupLabelKey !== match.labelKey;
  const Chevron = () => <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      {showGroup && (
        <>
          <span className="hidden truncate text-muted-foreground sm:inline">
            {t(match.groupLabelKey, match.groupLabel)}
          </span>
          <span className="hidden sm:inline">
            <Chevron />
          </span>
        </>
      )}
      {subLabel ? (
        <>
          <Link
            to={match.path}
            className="truncate text-muted-foreground transition-colors hover:text-foreground"
          >
            {t(match.labelKey, match.label)}
          </Link>
          <Chevron />
          <span className="truncate font-medium text-foreground">{subLabel}</span>
        </>
      ) : (
        <span className="truncate font-medium text-foreground">
          {t(match.labelKey, match.label)}
        </span>
      )}
    </nav>
  );
}
