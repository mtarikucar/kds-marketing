/**
 * Bulk-delete toast text.
 *
 * The backend's bulk-delete refuses WON / converted-tenant leads (deleting one
 * would orphan its provisioned tenant + earned commission) and returns how many
 * it skipped, precisely so the operator understands why fewer than selected were
 * removed. The list page previously dropped that `skippedProtected` count and
 * toasted only `deleted` — so selecting three WON leads and deleting showed a
 * bare "0 lead(s) deleted", reading as a silent no-op with no reason. This
 * surfaces the skip so the outcome is always explained.
 */
type TFn = (key: string, opts?: Record<string, unknown>) => string;

export interface BulkDeleteResult {
  deleted: number;
  skippedProtected?: number;
}

export function bulkDeleteToast(
  res: BulkDeleteResult | undefined,
  t: TFn,
): { text: string; tone: 'success' | 'info' } {
  const deleted = res?.deleted ?? 0;
  const skipped = res?.skippedProtected ?? 0;

  if (skipped > 0) {
    return {
      // Nothing removed (everything selected was protected) is informational,
      // not a success; a partial removal is still a success with a caveat.
      tone: deleted > 0 ? 'success' : 'info',
      text: t('leads.bulkDelete.partial', {
        defaultValue:
          '{{deleted}} deleted · {{skipped}} skipped — won or converted contacts can’t be deleted',
        deleted,
        skipped,
      }),
    };
  }

  return {
    tone: 'success',
    text: t('leads.bulkDelete.success', {
      defaultValue: '{{count}} lead(s) deleted',
      count: deleted,
    }),
  };
}

export interface BulkAssignResult {
  assigned: number;
  /** Already assigned to the target rep (no-op). */
  unchanged?: number;
  /** Ids not found in the workspace (deleted/merged between select and submit).
   *  The backend returns an id array; a number is tolerated defensively. */
  skipped?: string[] | number;
}

/**
 * Bulk-assign toast — sibling of {@link bulkDeleteToast}. The backend returns
 * `{ assigned, unchanged, skipped }` but the list page showed only `assigned`,
 * so re-assigning contacts already owned by that rep flashed a bare "0 assigned"
 * (a confusing no-op) and a stale selection silently dropped the not-found ids.
 * Surface both so every outcome is explained.
 */
export function bulkAssignToast(
  res: BulkAssignResult | undefined,
  t: TFn,
): { text: string; tone: 'success' | 'info' } {
  const assigned = res?.assigned ?? 0;
  const unchanged = res?.unchanged ?? 0;
  const skipped = Array.isArray(res?.skipped) ? res!.skipped.length : (res?.skipped ?? 0);
  const leftover = unchanged + skipped;

  if (assigned === 0) {
    // Nothing changed — everything was already on that rep, or couldn't be found.
    return {
      tone: 'info',
      text: t('leads.bulkAssign.noChange', {
        defaultValue:
          'No change — the selected contacts were already assigned to that rep, or could not be found',
      }),
    };
  }
  if (leftover > 0) {
    return {
      tone: 'success',
      text: t('leads.bulkAssign.partial', {
        defaultValue: '{{assigned}} reassigned · {{leftover}} left unchanged',
        assigned,
        leftover,
      }),
    };
  }
  return {
    tone: 'success',
    text: t('leads.bulkAssign.success', { count: assigned }),
  };
}
