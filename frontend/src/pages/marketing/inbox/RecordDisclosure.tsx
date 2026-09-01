import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface RecordDisclosureProps {
  /** Section heading — also the section's NAME in its failure sentence. */
  title: string;
  /** Mounted only while open, so a closed section fetches nothing. */
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * A record-card section that costs nothing until it is opened.
 *
 * The card has five sections. Two of them — estimates and appointments — each
 * need their own endpoint, for objects most contacts do not have, and firing
 * both on every row a rep clicks through would be two wasted requests per
 * person for a screen nobody looked at. So they are disclosures: the body is
 * an unrendered element until `open`, which means the child component function
 * never runs and its `useQuery` never registers. Nothing subtler than that is
 * needed — and nothing subtler would be honest, because a query that exists
 * but is `enabled: false` is still a query somebody can flip on by accident.
 *
 * The two sections that ride on `GET /leads/:id` are NOT disclosures, because
 * their data arrives with the person either way — see `useLeadRecord`.
 *
 * `open` is per-person state. The card is handed a new person rather than
 * remounted (selecting is not navigating), so the caller keys this by lead id;
 * without that, "I opened Randevular for Ayşe" becomes "Randevular is open for
 * whoever is selected next", and the section fetches for someone nobody asked
 * about.
 */
export function RecordDisclosure({
  title,
  children,
  'data-testid': testId,
}: RecordDisclosureProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
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
