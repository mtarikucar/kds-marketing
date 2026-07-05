import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, X, Search, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { MarketingUserInfo } from '../types';

interface RepRow extends MarketingUserInfo {
  status?: string;
  role?: string;
}

interface BulkActionToolbarProps {
  selectedCount: number;
  reps: RepRow[];
  onBulkAssign: (repId: string | null) => void;
  onClear: () => void;
  pending?: boolean;
  /** Optional — soft-delete the selected leads. */
  onBulkDelete?: () => void;
  /** Optional — enroll the selected leads into a workflow. */
  workflows?: { id: string; name: string }[];
  onEnroll?: (workflowId: string) => void;
}

/**
 * Sticky toolbar shown above the leads table when the manager has
 * selected one or more rows. Hosts the "Toplu Ata" dropdown (same
 * rep search UX as AssignCell) and a clear-selection button.
 */
export default function BulkActionToolbar({
  selectedCount,
  reps,
  onBulkAssign,
  onClear,
  pending,
  onBulkDelete,
  workflows,
  onEnroll,
}: BulkActionToolbarProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pendingEnroll, setPendingEnroll] = useState<{ id: string; name: string } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  if (selectedCount === 0) return null;

  return (
    <div className="sticky top-0 z-20 bg-surface border border-primary/30 rounded-xl shadow-sm p-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Users className="w-4 h-4 text-primary" aria-hidden="true" />
        {t('leads.bulkAssign.toolbar', { count: selectedCount })}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={pending}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {t('leads.bulkAssign.button')}
          </button>
          {open && (
            <div
              ref={popoverRef}
              className="absolute right-0 z-30 mt-1 w-64 bg-surface-raised border border-border rounded-lg shadow-lg p-2"
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
                  filtered.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        onBulkAssign(r.id);
                        setOpen(false);
                        setSearch('');
                      }}
                      disabled={pending}
                      className="w-full text-left px-2 py-1.5 rounded text-sm text-foreground hover:bg-surface-muted disabled:opacity-50"
                    >
                      {r.firstName} {r.lastName}
                    </button>
                  ))
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  onBulkAssign(null);
                  setOpen(false);
                  setSearch('');
                }}
                disabled={pending}
                className="mt-1 w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-danger hover:bg-danger-subtle border-t border-border disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                {t('leads.assignment.unassign')}
              </button>
            </div>
          )}
        </div>
        {/* Enroll into a workflow */}
        {onEnroll && workflows && workflows.length > 0 && (
          <select
            disabled={pending}
            defaultValue=""
            onChange={(e) => {
              const workflowId = e.target.value;
              // Always snap back to the placeholder so a cancelled (or
              // completed) pick never lingers as the visible selection.
              e.target.value = '';
              if (!workflowId) return;
              // Enrolling fans out automated outbound messages to every
              // selected lead — confirm via the design-system dialog (the
              // same guard the delete action gets) so a stray dropdown change
              // can't mass-message real customers.
              const wf = workflows.find((w) => w.id === workflowId);
              setPendingEnroll({ id: workflowId, name: wf?.name ?? '' });
            }}
            className="px-2 py-1.5 border border-border-strong rounded-lg text-sm bg-surface text-foreground disabled:opacity-50"
            aria-label={t('leads.bulkEnroll.label', 'Enroll in workflow')}
          >
            <option value="">{t('leads.bulkEnroll.label', 'Enroll in workflow…')}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}

        {/* Delete */}
        {onBulkDelete && (
          <button
            type="button"
            onClick={onBulkDelete}
            disabled={pending}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-danger/40 text-danger rounded-lg text-sm hover:bg-danger-subtle disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            {t('leads.bulkDelete.button', 'Delete')}
          </button>
        )}

        <button
          type="button"
          onClick={onClear}
          className="px-3 py-1.5 border border-border-strong rounded-lg text-sm text-foreground hover:bg-surface-muted"
        >
          {t('leads.bulkAssign.cancel')}
        </button>
      </div>

      <ConfirmDialog
        open={pendingEnroll !== null}
        onOpenChange={(o) => { if (!o) setPendingEnroll(null); }}
        title={t('leads.bulkEnroll.confirmTitle', { defaultValue: 'Enroll the selected leads?' })}
        description={t('leads.bulkEnroll.confirmDesc', {
          defaultValue: 'Enrolling {{count}} lead(s) into "{{name}}" may start sending automated messages.',
          count: selectedCount,
          name: pendingEnroll?.name ?? '',
        })}
        confirmLabel={t('leads.bulkEnroll.confirmButton', { defaultValue: 'Enroll' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        onConfirm={() => {
          if (pendingEnroll && onEnroll) onEnroll(pendingEnroll.id);
          setPendingEnroll(null);
        }}
      />
    </div>
  );
}
