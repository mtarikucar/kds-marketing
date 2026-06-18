import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';

/**
 * Public form submission → lead. Resolves the workspace from the FormDef,
 * de-dupes the lead by email/phone, and emits form.submitted (a workflow
 * trigger). Returns the redirect URL for the post/redirect/get flow.
 */
@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);
  private readonly sentinelCache = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly autoAssigner: LeadAutoAssignerService,
  ) {}

  async submit(formId: string, data: Record<string, string>): Promise<{ redirectUrl: string | null }> {
    // Defensive backstop (independent of the controller): cap the untrusted
    // dynamic-field map to ≤50 fields, key ≤100 chars, value ≤2000 chars.
    const capped: Record<string, string> = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (Object.keys(capped).length >= 50) break;
      if (typeof k !== 'string' || k.length > 100) continue;
      capped[k] = String(v).slice(0, 2000);
    }
    data = capped;

    const form = await this.prisma.formDef.findUnique({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');
    const workspaceId = form.workspaceId;

    const name = (data.name || data.fullName || data.contactPerson || '').trim();
    const email = (data.email || '').trim() || null;
    const phone = (data.phone || data.tel || '').trim() || null;
    // Canonical dedup keys — match the manual-create path so a form submit and a
    // hand-entered lead with the same (case/format-varying) email/phone collide.
    const emailNormalized = normalizeEmail(email);
    const phoneNormalized = normalizePhone(phone);
    const businessName = (data.businessName || data.company || name || 'Form lead').trim();

    const leadId = await this.prisma.$transaction(async (tx) => {
      // De-dupe on the NORMALIZED keys, skipping tombstoned (merged-away) leads
      // so a merge can't be resurrected by a later submission.
      let existing = null as { id: string; status: string } | null;
      if (emailNormalized || phoneNormalized) {
        existing = await tx.lead.findFirst({
          where: {
            workspaceId,
            mergedIntoId: null,
            OR: [
              ...(emailNormalized ? [{ emailNormalized }] : []),
              ...(phoneNormalized ? [{ phoneNormalized }] : []),
            ],
          },
          select: { id: true, status: true },
        });
      }
      if (existing) {
        // A re-engagement signal for an OPEN lead — but never overwrite a closed
        // (WON/LOST) lead's original source.
        if (existing.status !== 'WON' && existing.status !== 'LOST') {
          await tx.lead.updateMany({ where: { id: existing.id, workspaceId }, data: { source: 'WEBSITE' } });
        }
        return existing.id;
      }
      const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
      const lead = await tx.lead.create({
        data: {
          workspaceId,
          businessName,
          contactPerson: name || businessName,
          businessType: 'OTHER',
          source: 'WEBSITE',
          status: 'NEW',
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(emailNormalized ? { emailNormalized } : {}),
          ...(phoneNormalized ? { phoneNormalized } : {}),
          ...(autoOwner ? { assignedToId: autoOwner } : {}),
        },
      });
      const sentinel = await this.resolveSentinel(workspaceId);
      if (sentinel) {
        await tx.leadActivity.create({
          data: { leadId: lead.id, type: 'NOTE', title: `Form submission: ${form.name}`, description: this.summarize(data), createdById: sentinel },
        });
      }
      await this.outbox.append(
        {
          type: MarketingEventTypes.LeadCreated,
          idempotencyKey: `lead-created:${lead.id}`,
          payload: { workspaceId, leadId: lead.id, source: 'WEBSITE', occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
      return lead.id;
    });

    await this.outbox.append({
      type: MarketingEventTypes.FormSubmitted,
      idempotencyKey: `form-submitted:${formId}:${leadId}:${Date.now()}`,
      payload: { workspaceId, leadId, formId, fields: data, occurredAt: new Date().toISOString() },
    });

    return { redirectUrl: form.redirectUrl ?? null };
  }

  private summarize(data: Record<string, string>): string {
    return Object.entries(data)
      .filter(([k]) => !['_csrf'].includes(k))
      .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
      .join('\n')
      .slice(0, 2000);
  }

  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    if (this.sentinelCache.has(workspaceId)) return this.sentinelCache.get(workspaceId)!;
    const row = await this.prisma.marketingUser.findFirst({ where: { workspaceId, role: 'SYSTEM' }, select: { id: true } });
    const id = row?.id ?? null;
    this.sentinelCache.set(workspaceId, id);
    return id;
  }
}
