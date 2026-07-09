import { Body, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { payloadDigest, verifyNetgsmWebhookToken } from './netgsm-webhook.util';

/**
 * Unified public receiver for NetGSM pushes (santral events, İYS, voice/
 * autocall reports). NetGSM signs nothing, so the URL carries an HMAC token
 * only MARKETING_SECRET_KEY holders can mint. Phase 0: verify + archive +
 * dedupe (202). Domain consumers (screen-pop, CDR upsert, İYS apply) attach
 * in Phases 2/3/5 by reading NetgsmWebhookEvent / subscribing to bus events.
 */
@Controller('public/netgsm')
export class NetgsmEventsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  @Post(':workspaceId/:token/events')
  @HttpCode(202)
  async events(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'events', token)) throw new NotFoundException();
    const b = (body ?? {}) as Record<string, unknown>;
    const externalId =
      (typeof b.unique_id === 'string' && b.unique_id) ||
      (typeof b.uniqueid === 'string' && b.uniqueid) ||
      payloadDigest(body);
    // Duplicate delivery — first archive row wins. skipDuplicates emits a
    // native ON CONFLICT DO NOTHING, so a concurrent NetGSM retry is a clean
    // no-op instead of a P2002 500 (Prisma EMULATES upsert for this compound
    // key + empty-update shape, which loses the insert race).
    await this.prisma.netgsmWebhookEvent.createMany({
      data: [{ workspaceId, purpose: 'events', externalId, payload: (body ?? {}) as object }],
      skipDuplicates: true,
    });
    return { ok: true };
  }

  /**
   * İYS push-back (Phase 2 Task 4). Unlike every other NetGSM push, the body
   * is a bare JSON ARRAY of consent-change elements (not an object) — İYS
   * pushes unsigned, so the HMAC token in the URL is still the only thing
   * standing between this route and a forged consent flip. Each element
   * dedupes independently on `transactionid`/`submitid` (falling back to a
   * digest of that one element — never the whole array, so one genuinely new
   * element in an otherwise-seen batch is never masked by its neighbors).
   *
   * Dedup + fan-out: `createMany` alone can't report WHICH rows were new (it
   * only returns a count), so existing externalIds for this batch are read
   * FIRST — only the rows that come back missing are inserted AND published.
   * `createMany({skipDuplicates: true})` remains the insert call (the race
   * backstop for a concurrent redelivery of the same batch); the publish side
   * is further protected by `OutboxService.append`'s own idempotencyKey
   * dedup, so even a genuine concurrent double-publish attempt collapses to
   * one outbox row.
   *
   * The controller stays business-logic free (hub layering — see
   * NetgsmModule's docstring): it never resolves a lead or writes a
   * ConsentRecord itself. It only archives + republishes; IysWebhookConsumer
   * (marketing/compliance) is the one place that applies the ONAY/RET to a
   * lead. The event `type` string below mirrors marketing's own
   * `MarketingEventTypes.IysConsentReceived` (marketing-event-types.ts) —
   * kept as a literal here rather than imported, so the hub never takes a
   * compile-time dependency on the marketing bounded context.
   */
  @Post(':workspaceId/:token/iys')
  @HttpCode(202)
  async iys(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'iys', token)) throw new NotFoundException();
    const elements = Array.isArray(body) ? body : [];
    if (elements.length === 0) return { ok: true };

    const rows = elements.map((raw) => {
      const el = (raw ?? {}) as Record<string, unknown>;
      const externalId =
        this.stringField(el, ['transactionid']) ?? this.stringField(el, ['submitid']) ?? payloadDigest(el);
      return { el, externalId };
    });

    // Read what's already archived for this batch BEFORE inserting — the
    // clean way to know which rows are genuinely new (createMany's return is
    // just a count, not which rows landed).
    const existing = await this.prisma.netgsmWebhookEvent.findMany({
      where: { workspaceId, purpose: 'iys', externalId: { in: rows.map((r) => r.externalId) } },
      select: { externalId: true },
    });
    const existingIds = new Set(existing.map((e) => e.externalId));
    const fresh = rows.filter((r) => !existingIds.has(r.externalId));
    if (fresh.length === 0) return { ok: true };

    await this.prisma.netgsmWebhookEvent.createMany({
      data: fresh.map((r) => ({ workspaceId, purpose: 'iys', externalId: r.externalId, payload: r.el as object })),
      skipDuplicates: true,
    });

    for (const r of fresh) {
      const recipient = this.stringField(r.el, ['recipient', 'msisdn', 'gsmnumber']) ?? '';
      const type = this.stringField(r.el, ['type']) ?? 'MESAJ';
      const statusRaw = (this.stringField(r.el, ['status', 'durum']) ?? '').toUpperCase();
      const status = statusRaw === 'RET' ? 'RET' : 'ONAY';
      const source = this.stringField(r.el, ['source', 'kaynak']) ?? '';
      const transactionId =
        this.stringField(r.el, ['transactionid']) ?? this.stringField(r.el, ['submitid']) ?? r.externalId;

      await this.outbox.append({
        type: 'marketing.iys.consent.v1',
        tenantId: null,
        payload: { workspaceId, recipient, type, status, source, transactionId },
        idempotencyKey: `${workspaceId}:iys:${r.externalId}`,
      });
    }

    return { ok: true };
  }

  private stringField(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  }
}
