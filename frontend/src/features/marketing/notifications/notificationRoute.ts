/**
 * Where a notification click should land.
 *
 * `MarketingNotification` has no `link`, `entityType` or `entityId` column
 * (schema.prisma) — `type` plus the free-form `metadata` JSON is the entire
 * routable payload, and the controller hands both to the browser unchanged.
 *
 * The table is keyed on (type, metadata SHAPE) rather than on type alone
 * because FOLLOW_UP_REMINDER has four producers and three metadata shapes:
 *
 *   producer                                    metadata
 *   marketing-scheduler.service (follow-up due) { leadId, dueAt }
 *   marketing-leads.service (single assign)     { leadId, assignedBy }
 *   marketing-leads.service (bulkAssign)        { leadIds[], assignedBy, bulk }
 *   settlement-commission.consumer (legacy)     { tenantId, leadId, ... }
 *
 * A flat `Record<type, path>` would build `/leads/undefined` for the bulk
 * shape, which is why this is a function and not a map.
 */

/** The slice of a notification row this resolver reads. */
export type RoutableNotification = { type?: string | null; metadata?: unknown };

export interface NotificationRouteOptions {
  /**
   * Whether the workspace is entitled to the commissions add-on. `/commissions`
   * is `@RequiresFeature('commissions')` on the backend, so sending an
   * unentitled workspace there lands it on a page whose every request 403s.
   * Defaults to FALSE: the caller has to prove the entitlement, and a credited
   * commission always carries the referral lead, which anyone can open.
   */
  hasCommissions?: boolean;
}

/**
 * Ids reach `navigate()` interpolated into a path, and metadata is written by
 * workflow steps and event consumers — i.e. partly operator-influenced. Every
 * id read goes through this guard, so `../../platform/workspaces` or an
 * absolute URL resolves to null instead of to a route.
 */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const meta = (n: RoutableNotification): Record<string, unknown> | null =>
  n.metadata && typeof n.metadata === 'object' && !Array.isArray(n.metadata)
    ? (n.metadata as Record<string, unknown>)
    : null;

const id = (m: Record<string, unknown> | null, key: string): string | null => {
  const v = m?.[key];
  return typeof v === 'string' && ID.test(v) ? v : null;
};

/**
 * The in-app destination for a notification, or `null` when this kind has no
 * honest one (the caller still marks it read — a dead click beats navigating
 * somewhere invented).
 */
export function notificationRoute(
  n: RoutableNotification,
  opts: NotificationRouteOptions = {},
): string | null {
  const m = meta(n);
  const lead = id(m, 'leadId');

  switch (n.type) {
    case 'TASK_ASSIGNED':
      // TasksPage reads only `?tab=` — there is no per-task deep link, so the
      // list is the destination. Deliberately NOT an invented `?task=` param.
      return '/tasks';

    case 'INACTIVE_LEAD':
      return lead ? `/leads/${lead}` : null;

    case 'CONVERSATION_ASSIGNED':
      // The inbox selects a PERSON in React state; there is no URL form for a
      // conversation id. With leadId (stamped by the producer since this
      // change) we open the person; rows written before it, the inbox itself.
      return lead ? `/leads/${lead}` : '/inbox';

    case 'COMMISSION_EARNED':
      return opts.hasCommissions ? '/commissions' : lead ? `/leads/${lead}` : null;

    case 'FOLLOW_UP_REMINDER':
      if (lead) return `/leads/${lead}`;
      // bulkAssign sends `leadIds[]` and no singular leadId — N leads cannot be
      // opened at once, so the list is the honest target.
      if (Array.isArray(m?.leadIds) && (m!.leadIds as unknown[]).length > 0) return '/leads';
      return null;

    case 'WORKFLOW':
      // Rows created before the producer started stamping leadId carry no
      // metadata at all: no-op.
      return lead ? `/leads/${lead}` : null;

    default:
      // `type` is a free-form String column with no enum behind it. Unknown
      // kinds — including DEMO_REMINDER / OFFER_EXPIRING / TASK_DUE, named in
      // the schema comment but emitted by no producer — are no-ops.
      return null;
  }
}
