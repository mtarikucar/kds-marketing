import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  UserGroupIcon,
  XMarkIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
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
}: BulkActionToolbarProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
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
    <div className="sticky top-0 z-20 bg-white border border-primary/30 rounded-xl shadow-sm p-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
        <UserGroupIcon className="w-4 h-4 text-primary" />
        {t('leads.bulkAssign.toolbar', { count: selectedCount })}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={pending}
            className="px-3 py-1.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {t('leads.bulkAssign.button')}
          </button>
          {open && (
            <div
              ref={popoverRef}
              className="absolute right-0 z-30 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-2"
            >
              <div className="relative mb-2">
                <MagnifyingGlassIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  autoFocus
                  placeholder={t('leads.assignment.searchRep')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-2 py-1.5 border border-gray-300 rounded-md text-sm outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="max-h-56 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="text-xs text-gray-400 px-2 py-3 text-center">
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
                      className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
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
                className="mt-1 w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-red-600 hover:bg-red-50 border-t border-gray-100 disabled:opacity-50"
              >
                <XMarkIcon className="w-3.5 h-3.5" />
                {t('leads.assignment.unassign')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
        >
          {t('leads.bulkAssign.cancel')}
        </button>
      </div>
    </div>
  );
}
