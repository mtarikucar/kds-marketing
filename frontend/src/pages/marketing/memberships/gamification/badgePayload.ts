export type BadgeFormValues = {
  key: string;
  name: string;
  ruleType: 'POINTS' | 'LESSONS' | 'COURSES';
  threshold: string;
  iconUrl: string;
};

/**
 * Build the write body for a badge create/update from the form values.
 *
 * The subtlety is `iconUrl` on EDIT: the backend PATCH merges by Prisma
 * undefined-skip (`...(dto.iconUrl !== undefined && { iconUrl })`), so sending
 * `undefined` for an emptied field leaves the OLD icon in place — the operator
 * can't clear a badge's icon. On edit we therefore send `null` to actively clear
 * it (UpdateBadgeDto's `@IsOptional()` accepts null). On CREATE `undefined` is
 * correct — the service defaults a missing icon to null. See the
 * clear-doesn't-persist bug class (same shape as the TagsPage color fix).
 */
export function buildBadgeBody(v: BadgeFormValues, isEdit: boolean) {
  const iconUrl = v.iconUrl.trim();
  return {
    name: v.name,
    ruleType: v.ruleType,
    threshold: Number(v.threshold) || 0,
    iconUrl: iconUrl ? iconUrl : isEdit ? null : undefined,
  };
}
