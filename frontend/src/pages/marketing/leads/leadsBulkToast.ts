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
