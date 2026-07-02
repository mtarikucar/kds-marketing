import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Lets a detail page hand the header breadcrumb the current record's name, so a
 * route like `/leads/123` reads "Contacts › Leads › Acme Corp" instead of a
 * generic "Detail". The value is cleared on unmount so a stale name never leaks
 * onto the next page.
 */
interface BreadcrumbState {
  detailLabel: string | null;
  setDetailLabel: (label: string | null) => void;
}

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
  detailLabel: null,
  setDetailLabel: (detailLabel) => set({ detailLabel }),
}));

/** Register the current record's display name for the header breadcrumb leaf. */
export function useBreadcrumbLabel(label?: string | null) {
  const setDetailLabel = useBreadcrumbStore((s) => s.setDetailLabel);
  useEffect(() => {
    setDetailLabel(label && label.trim() ? label : null);
    return () => setDetailLabel(null);
  }, [label, setDetailLabel]);
}
