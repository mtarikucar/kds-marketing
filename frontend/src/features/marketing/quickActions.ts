import type { LucideIcon } from 'lucide-react';
import { UserPlus, ClipboardList, Target, Building2 } from 'lucide-react';

/**
 * Canonical "create a thing" actions surfaced from the header "+ Create" menu
 * AND the command palette, so there is ONE definition of the quick-create set.
 *
 * Each `to` is a router path. Actions that have a dedicated create route use it
 * (`/leads/new`); the rest deep-link to their list page with `?create=1`, a
 * convention the target list pages honour by auto-opening their create modal
 * (wired per page). Labels carry an English fallback so the partial locales
 * (ar/ru/uz) still read well when the `quickCreate.*` key is missing.
 */
export interface QuickAction {
  id: string;
  labelKey: string;
  label: string;
  icon: LucideIcon;
  to: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'lead', labelKey: 'quickCreate.lead', label: 'New lead', icon: UserPlus, to: '/leads/new' },
  { id: 'task', labelKey: 'quickCreate.task', label: 'New task', icon: ClipboardList, to: '/tasks?create=1' },
  { id: 'opportunity', labelKey: 'quickCreate.opportunity', label: 'New opportunity', icon: Target, to: '/opportunities?create=1' },
  { id: 'company', labelKey: 'quickCreate.company', label: 'New company', icon: Building2, to: '/companies?create=1' },
];
