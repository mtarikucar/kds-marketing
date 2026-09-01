import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface DisclosureProps {
  /** Section heading — also the section's NAME in its failure sentence. */
  title: string;
  /** Mounted only while open, so a closed section fetches nothing. */
  children: ReactNode;
  /**
   * Open on first render. The stack in the Studio's recurring tools uses it for
   * the ONE section a person opened the drawer to see, so `?tool=money` costs
   * exactly one query rather than five — or zero, which would make the drawer
   * open onto a wall of headings with nothing under any of them.
   *
   * Initial state only: it seeds `useState` and never re-opens a section the
   * reader has closed.
   */
  defaultOpen?: boolean;
  'data-testid'?: string;
}

/**
 * A section that costs nothing until it is opened.
 *
 * The body is an unrendered element until `open`, which means the child
 * component function never runs and its `useQuery` never registers. Nothing
 * subtler than that is needed — and nothing subtler would be honest, because a
 * query that exists but is `enabled: false` is still a query somebody can flip
 * on by accident.
 *
 * `open` is per-TARGET state wherever the host is handed a new subject rather
 * than remounted (the record card's person, say). Such a host keys this by that
 * subject's id; without it, "I opened Randevular for Ayşe" becomes "Randevular
 * is open for whoever is selected next", and the section fetches for someone
 * nobody asked about.
 *
 * Lifted out of `inbox/RecordDisclosure` when the Studio's recurring tools grew
 * stacks of the same shape. That file is now a thin alias over this one, so the
 * record card and the drawer share one implementation rather than drifting.
 */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  'data-testid': testId,
}: DisclosureProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section data-testid={testId} className="space-y-2 border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-start"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          {open ? t('surface.section.hide', 'Gizle') : t('surface.section.show', 'Göster')}
          <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
      {open && children}
    </section>
  );
}

export default Disclosure;
