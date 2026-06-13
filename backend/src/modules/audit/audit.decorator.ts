import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA = 'audit:metadata';

export interface AuditOptions {
  /** Stable dotted action name, e.g. "workspace.status.update". */
  action: string;
  /** The kind of thing being acted on, e.g. "workspace" | "order" | "commission". */
  resourceType: string;
  /** Route param holding the resource id (e.g. 'id', 'orderId'). */
  resourceIdParam?: string;
  /**
   * Whitelist of request-body keys to copy into `metadata`. Keep it to
   * non-sensitive, decision-relevant fields (e.g. the new `status`) — never
   * secrets or whole bodies.
   */
  captureBody?: string[];
}

/**
 * Marks a controller handler as auditable (backlog #3). The {@link AuditInterceptor}
 * picks up this metadata and writes one append-only audit row per invocation,
 * recording the actor, resource, outcome and correlation id.
 *
 * Declarative on purpose: the audit concern stays out of the service bodies, and
 * which actions are "material" is visible at a glance on the routes themselves.
 */
export const Audit = (options: AuditOptions) =>
  SetMetadata(AUDIT_METADATA, options);
