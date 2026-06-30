/**
 * Meta returns an opaque error — "Object with ID 'act_…' does not exist, cannot
 * be loaded due to missing permissions, or does not support this operation" —
 * when the connected token lacks the role/scope for a WRITE. Campaign
 * create / budget / status changes need the `ads_management` permission (not
 * just `ads_read`, which is enough for the insights this product reads) AND an
 * admin/advertiser role on the ad account. Reads can succeed while writes fail.
 *
 * Append actionable guidance to that opaque message so the operator knows to
 * reconnect with a properly-scoped token instead of staring at a Graph error.
 */
const PERMISSION_SIGNAL =
  /does not exist|missing permission|cannot be loaded|ads_management|do(?:es)? not support this operation/i;

export function withPermissionHint(message: string | undefined | null): string {
  const m = message ?? '';
  if (!PERMISSION_SIGNAL.test(m)) return m;
  return `${m} — This action needs a Meta token with the 'ads_management' permission and an admin role on the ad account; reconnect the ad account with full ads-management access.`;
}
