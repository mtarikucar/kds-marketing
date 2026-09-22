/**
 * "Somebody should hear about this" for the three commerce moments that happen
 * while nobody is looking: a customer answering a quote on the public page, a
 * payment landing from a PSP webhook, an agreement being signed.
 *
 * All three used to be silent (`quote-answer-silent`, `no-payment-receipt`,
 * `esign-not-emailed`): the row changed and the deal stalled because the rep
 * found out days later, if ever.
 *
 * A plain function rather than a provider on purpose — its three callers are a
 * service, a domain-event consumer and a mail service that are already wired,
 * and a new injectable would need module registration for fifteen lines of
 * resolution.
 *
 * Two rules:
 *
 * - **It never throws.** It runs after the money has already moved. A bell that
 *   cannot be rung must never look like a failed payment.
 * - **The owner comes from the MEMBERSHIP**, never `MarketingUser.workspaceId`
 *   — that column is the user's HOME workspace, so an owner whose home is
 *   another workspace would be silently dropped and the moment announced to
 *   nobody.
 */

export interface CommerceNotice {
  workspaceId: string;
  /** The person the document belongs to, when it belongs to one. */
  leadId?: string | null;
  /** `QUOTE_ANSWERED` | `INVOICE_PAID` | `DOCUMENT_SIGNED`. */
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Only the three delegates this needs — so a test hands over three mocks. */
export interface CommerceNotifyPrisma {
  lead: { findFirst(args: unknown): Promise<{ assignedToId?: string | null } | null> };
  workspaceMembership: { findFirst(args: unknown): Promise<{ userId: string } | null> };
  marketingNotification: { create(args: unknown): Promise<unknown> };
}

export interface NotifyLogger {
  warn(message: string): void;
}

/** The user told, or null when there was nobody to tell (or the write failed). */
export async function notifyCommerce(
  prisma: CommerceNotifyPrisma,
  notice: CommerceNotice,
  logger?: NotifyLogger,
): Promise<string | null> {
  const { workspaceId, leadId } = notice;
  if (!workspaceId) return null;

  try {
    const userId = await recipient(prisma, workspaceId, leadId ?? null);
    if (!userId) return null;

    await prisma.marketingNotification.create({
      // `workspaceId` is spelled out here, not derived from the recipient's
      // home workspace: the bell reads (workspaceId, userId), so a row born in
      // the wrong workspace is a row nobody ever sees.
      data: {
        workspaceId,
        userId,
        type: notice.type,
        title: notice.title.slice(0, 200),
        message: notice.message.slice(0, 500),
        metadata: { ...(leadId ? { leadId } : {}), ...(notice.metadata ?? {}) },
      },
    });
    return userId;
  } catch (e: unknown) {
    logger?.warn(
      `commerce notification skipped (workspace=${workspaceId}, type=${notice.type}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

/** The rep who owns the person, else the workspace's first active owner. */
async function recipient(
  prisma: CommerceNotifyPrisma,
  workspaceId: string,
  leadId: string | null,
): Promise<string | null> {
  if (leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { assignedToId: true },
    });
    if (lead?.assignedToId) return lead.assignedToId;
  }
  const owner = await prisma.workspaceMembership.findFirst({
    where: { workspaceId, role: 'OWNER', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}
