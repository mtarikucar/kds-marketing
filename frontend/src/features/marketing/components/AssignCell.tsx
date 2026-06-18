import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UserPlus, PencilLine, X, Search } from 'lucide-react';
import marketingApi from '../api/marketingApi';
import type { MarketingUserInfo } from '../types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

interface RepRow extends MarketingUserInfo {
  status?: string;
  role?: string;
}

interface AssignCellProps {
  leadId: string;
  currentAssignee?: MarketingUserInfo | null;
  /** Disable editing — used to render a read-only label for REP. */
  readOnly?: boolean;
  /** Optional: invalidate parent queries on success (e.g. lead detail). */
  onAssigned?: () => void;
}

/**
 * Inline cell that renders either "+ Ata" (when no owner) or
 * "FirstName LastName ✎" (when owned). Clicking either opens a small
 * popover with a searchable rep list + "Atamayı Kaldır" link. Manager-only
 * UI — for reps the cell renders as plain text via `readOnly`.
 *
 * Lives in the leads table and on the lead detail page; both targets
 * share the same mutation so toast/error handling is uniform.
 */
export default function AssignCell({
  leadId,
  currentAssignee,
  readOnly,
  onAssigned,
}: AssignCellProps) {
  const { t } = useTranslation('marketing');
  // Defense-in-depth: the rep list + inline (re)assignment is a manager-only
  // capability. Rather than trust every caller to pass `readOnly` for a REP,
  // also derive it from the authenticated role here. A non-manager can then
  // never fire the manager-only GET /users (which 403s) nor render the editor,
  // even if a future caller forgets `readOnly`. Mirrors the role check the
  // leads list/detail pages already do before mounting this cell.
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const effectiveReadOnly = readOnly || !isManager;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Reps list is shared across the leads page rows — keep one cache
  // key so we don't refetch per row.
  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    // Don't load until the popover is at least opened once on the page;
    // the lead detail page already prefetches with the same key, so
    // hitting it again here is free. Gated on manager role too (see above)
    // so a REP-rendered cell never fires this manager-only request.
    enabled: !effectiveReadOnly,
    staleTime: 60_000,
  });

  const activeReps = useMemo(
    () => reps.filter((r) => r.role === 'REP' && (r.status ?? 'ACTIVE') === 'ACTIVE'),
    [reps],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeReps;
    return activeReps.filter((r) =>
      `${r.firstName} ${r.lastName}`.toLowerCase().includes(q),
    );
  }, [activeReps, search]);

  const assignMutation = useMutation({
    // `repId` null → unassign (backend accepts assignedToId null/empty).
    mutationFn: (repId: string | null) =>
      marketingApi.patch(`/leads/${leadId}/assign`, {
        assignedToId: repId ?? null,
      }),
    onSuccess: (_data, repId) => {
      // Invalidate both list and detail so the updated owner shows up
      // everywhere without a manual refresh.
      queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
      toast.success(
        repId === null
          ? t('leads.assignment.unassignSuccess')
          : t('leads.assignment.success'),
      );
      setOpen(false);
      setSearch('');
      onAssigned?.();
    },
    onError: () => toast.error(t('leads.assignment.error')),
  });

  // Click outside / Escape closes. The Escape branch also clears the
  // search so reopening starts clean.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch('');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setSearch('');
      }
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (effectiveReadOnly) {
    return (
      <span className="text-muted-foreground text-sm">
        {currentAssignee
          ? `${currentAssignee.firstName} ${currentAssignee.lastName}`
          : t('leads.assignment.unassigned')}
      </span>
    );
  }

  return (
    <div className="relative inline-block text-left">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          // Row click navigates to detail — stop propagation so the
          // popover toggle doesn't also fire the row's link.
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className={
          currentAssignee
            ? 'inline-flex items-center gap-1.5 text-foreground hover:text-primary group text-sm'
            : 'inline-flex items-center gap-1 text-primary hover:text-primary/80 text-sm font-medium'
        }
      >
        {currentAssignee ? (
          <>
            <span>
              {currentAssignee.firstName} {currentAssignee.lastName}
            </span>
            <PencilLine className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
          </>
        ) : (
          <>
            <UserPlus className="w-4 h-4" aria-hidden="true" />
            {t('leads.assignment.assignButton')}
          </>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute z-30 mt-1 left-0 w-64 bg-surface-raised border border-border rounded-lg shadow-lg p-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative mb-2">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" aria-hidden="true" />
            <input
              type="text"
              autoFocus
              placeholder={t('leads.assignment.searchRep')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-2 py-1.5 border border-border-strong rounded-md text-sm bg-surface text-foreground outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-3 text-center">
                {t('leads.assignment.noReps')}
              </p>
            ) : (
              filtered.map((r) => {
                const isCurrent = currentAssignee?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => assignMutation.mutate(r.id)}
                    disabled={isCurrent || assignMutation.isPending}
                    className="w-full text-left px-2 py-1.5 rounded text-sm text-foreground hover:bg-surface-muted disabled:bg-primary/5 disabled:text-primary disabled:cursor-default"
                  >
                    {r.firstName} {r.lastName}
                  </button>
                );
              })
            )}
          </div>
          {currentAssignee && (
            <button
              type="button"
              onClick={() => assignMutation.mutate(null)}
              disabled={assignMutation.isPending}
              className="mt-1 w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-danger hover:bg-danger-subtle border-t border-border"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
              {t('leads.assignment.unassign')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
