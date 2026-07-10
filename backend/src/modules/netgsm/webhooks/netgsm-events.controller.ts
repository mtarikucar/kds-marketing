import { Body, Controller, HttpCode, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { payloadDigest, verifyNetgsmWebhookToken } from './netgsm-webhook.util';
import { normalizeSantralEvent } from './santral-event-normalizer';

type WebhookPurpose = 'events' | 'iys' | 'voice-report' | 'autocall-report';
interface WebhookRow {
  el: Record<string, unknown>;
  externalId: string;
  /**
   * `events`-route only: the bare unique_id/uniqueid (or digest fallback)
   * part of the composite `externalId` below, kept alongside it so the
   * per-element publish step can fall back to it (never to the composite
   * `externalId`, which already has the scenario token baked in — reusing it
   * would double-suffix the idempotencyKey). Unused by `iys`.
   */
  idPart?: string;
}

/**
 * Unified public receiver for NetGSM pushes (santral events, İYS, voice/
 * autocall reports). NetGSM signs nothing, so the URL carries an HMAC token
 * only MARKETING_SECRET_KEY holders can mint. Phase 0: verify + archive +
 * dedupe (202). Domain consumers (screen-pop, CDR upsert, İYS apply) attach
 * in Phases 2/3/5 by reading NetgsmWebhookEvent / subscribing to bus events.
 *
 * `@SkipThrottle()` on every route below (NetGSM Phase 3 Task 6, Phase-0
 * finding): NetGSM pushes every tenant's santral events, İYS push-backs, AND
 * voice/autocall reports from a small, fixed set of its own server IPs —
 * machine traffic, not a browser's. The global 300 req/min PER-IP
 * `ThrottlerGuard` (app-wide `APP_GUARD`) would throttle that shared IP into
 * 429s under real call/İYS/voice volume across many tenants, exactly like
 * `InternalEventsController`'s own `@SkipThrottle()` for core's single egress
 * IP.
 */
@Controller('public/netgsm')
export class NetgsmEventsController {
  private readonly logger = new Logger(NetgsmEventsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Santral live call events (Phase 3 Task 1). NetGSM's Netsantral usually
   * pushes ONE scenario object per call leg, but the body may also arrive as
   * an array (a lone object is wrapped as a one-element array so both shapes
   * reuse the exact same fan-out path as the `iys` route below).
   *
   * Archive-then-normalize, same layering as `iys`: every element is
   * archived regardless (raw payload kept for audit + as the CDR
   * reconciliation backstop), but only elements that are BOTH new (not
   * already archived by a previous delivery) AND normalize to a recognized
   * scenario (`normalizeSantralEvent` — Inbound_call/Answer/Hangup/cdr) are
   * published as a typed `marketing.telephony.call_event.v1` outbox event.
   * An unrecognized scenario is archived but never published — the hub
   * still doesn't know what the future scenario means, so it must never
   * synthesize a typed event for it (same fail-closed shape as İYS's
   * unknown-status/type skip below).
   *
   * CRITICAL — one call leg fans out to MULTIPLE scenario pushes
   * (Inbound_call → Answer → Hangup → cdr) that all share the SAME
   * unique_id. Unlike `iys`'s transactionid (genuinely one-shot), keying the
   * archive purely on unique_id would let the FIRST scenario delivered claim
   * that externalId under `@@unique([workspaceId,purpose,externalId])` and
   * silently swallow every later scenario for the same call (never archived,
   * never published) — defeating Task 2, which needs all of them. So the
   * events-route archive `externalId` is `${idPart}:${scenarioToken}`:
   * `idPart` is unique_id/uniqueid (or a payload digest when absent, exactly
   * as before), and `scenarioToken` is the raw scenario/durum/event field
   * value, lowercased/trimmed (falling back to the normalized `kind`, or
   * finally a digest of the element, so two different unrecognized-scenario
   * elements sharing a unique_id still don't collide). Same unique_id + same
   * scenario token still dedupes to ONE archived row (a genuine redelivery);
   * same unique_id + a DIFFERENT scenario token gets its own row and its own
   * publish.
   */
  @Post(':workspaceId/:token/events')
  @HttpCode(202)
  @SkipThrottle()
  async events(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'events', token)) throw new NotFoundException();
    const elements = Array.isArray(body) ? body : [body ?? {}];
    if (elements.length === 0) return { ok: true };

    const rows: WebhookRow[] = elements.map((raw) => {
      const el = (raw ?? {}) as Record<string, unknown>;
      const idPart = this.stringField(el, ['unique_id', 'uniqueid']) ?? payloadDigest(el);
      const scenarioToken = this.scenarioToken(el);
      return { el, externalId: `${idPart}:${scenarioToken}`, idPart };
    });

    const fresh = await this.archiveFresh(workspaceId, 'events', rows);
    if (fresh.length === 0) return { ok: true };

    for (const r of fresh) {
      const normalized = normalizeSantralEvent(r.el);
      if (!normalized) {
        this.logger.warn(`unrecognized santral scenario — element ${r.externalId} archived, not published`);
        continue;
      }
      await this.outbox.append({
        type: 'marketing.telephony.call_event.v1',
        tenantId: null,
        payload: { workspaceId, ...normalized },
        idempotencyKey: `${workspaceId}:santral:${normalized.uniqueId ?? r.idPart}:${normalized.kind}`,
      });
    }

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
   *
   * STATUS IS STRICT TRI-STATE — never fail-open to ONAY. Every element is
   * archived regardless (the raw payload is always kept for audit), but only
   * an element whose status is EXACTLY 'ONAY' or EXACTLY 'RET' is published
   * as a `marketing.iys.consent.v1` consent event. Anything else (a typo, a
   * schema-drift field rename, garbage) is logged and left unpublished — this
   * is a compliance signal, so an ambiguous element must never be coerced
   * into granting marketing permission.
   *
   * TYPE IS STRICT TOO — never defaulted to MESAJ. Only 'MESAJ'/'ARAMA'/
   * 'EPOSTA' publish; an unrecognized/missing type is archived but not
   * published, same fail-closed treatment as an unrecognized status (a
   * missing type must never be silently assumed to be SMS consent).
   */
  @Post(':workspaceId/:token/iys')
  @HttpCode(202)
  @SkipThrottle()
  async iys(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'iys', token)) throw new NotFoundException();
    const elements = Array.isArray(body) ? body : [];
    if (elements.length === 0) return { ok: true };

    const rows: WebhookRow[] = elements.map((raw) => {
      const el = (raw ?? {}) as Record<string, unknown>;
      const externalId =
        this.stringField(el, ['transactionid']) ?? this.stringField(el, ['submitid']) ?? payloadDigest(el);
      return { el, externalId };
    });

    const fresh = await this.archiveFresh(workspaceId, 'iys', rows);
    if (fresh.length === 0) return { ok: true };

    for (const r of fresh) {
      const statusRaw = (this.stringField(r.el, ['status', 'durum']) ?? '').toUpperCase();
      // Strict tri-state: only an EXACT 'ONAY'/'RET' is ever published as a
      // consent event. The element is already archived above regardless (for
      // audit) — an unrecognized status just never reaches the consumer that
      // applies ONAY/RET to a lead, instead of silently fail-opening to ONAY.
      if (statusRaw !== 'ONAY' && statusRaw !== 'RET') {
        this.logger.warn(`unrecognized İYS status: ${statusRaw || '(empty)'} — element ${r.externalId} archived, not published`);
        continue;
      }
      const status = statusRaw;
      // TYPE IS STRICT TRI-STATE TOO — never fail-open to MESAJ. Only an
      // element whose type is EXACTLY 'MESAJ'/'ARAMA'/'EPOSTA' is published;
      // anything else (missing, a typo, a schema-drift rename) is logged and
      // left unpublished (still archived above regardless, for audit) —
      // defaulting an unrecognized type to MESAJ would let IysWebhookConsumer
      // apply an ARAMA/EPOSTA (or outright garbage) row's ONAY/RET as if it
      // were SMS marketing consent, which it was never proven to be.
      const typeRaw = (this.stringField(r.el, ['type']) ?? '').toUpperCase();
      if (typeRaw !== 'MESAJ' && typeRaw !== 'ARAMA' && typeRaw !== 'EPOSTA') {
        this.logger.warn(`unrecognized İYS type: ${typeRaw || '(empty)'} — element ${r.externalId} archived, not published`);
        continue;
      }
      const type = typeRaw;
      const recipient = this.stringField(r.el, ['recipient', 'msisdn', 'gsmnumber']) ?? '';
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

  /**
   * Voice-campaign report push (NetGSM Phase 5 Task 3). Voice DOES push call
   * outcomes (unlike SMS, which is DLR-polled) — body may be a lone object or
   * an array, same tolerant shape as `events` above. A single call can get
   * MULTIPLE distinct-state pushes over its lifetime (an intermediate signal
   * followed by the final outcome), so the archive key is scoped by state,
   * exactly like `events`' scenario-scoped externalId:
   * `${relationidPart}:${stateToken}`. A genuine redelivery of the SAME
   * call+state collapses onto the SAME archived row (no re-publish); a
   * DIFFERENT state for the SAME call gets its own row and its own publish —
   * VoiceReportConsumer (marketing/campaigns) is the one that decides which
   * state, if any, actually updates `CampaignRecipient` (it never regresses a
   * terminal ANSWERED outcome).
   *
   * Correlates purely by `relationid` (= `CampaignRecipient.id`, stamped at
   * send time — see campaign-sender.service.ts's `sendVoice`) — an element
   * with no resolvable relationid is archived for audit but never published,
   * same fail-closed treatment as `events`' unrecognized scenario / `iys`'s
   * unrecognized status/type above (this controller stays business-logic
   * free; it never touches CampaignRecipient itself). Field reads use
   * `numOrStr` (not the string-only `stringField`) because NetGSM's JSON body
   * may carry `durum`/`bilsec`/`push_button` as either a string or a bare
   * number — the exact wire shape isn't live-verified, same "researched, not
   * yet live-verified" status `VoicesmsSendClient` itself carries.
   */
  @Post(':workspaceId/:token/voice-report')
  @HttpCode(202)
  @SkipThrottle()
  async voiceReport(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'voice-report', token)) throw new NotFoundException();
    const elements = Array.isArray(body) ? body : [body ?? {}];
    if (elements.length === 0) return { ok: true };

    const rows: WebhookRow[] = elements.map((raw) => {
      const el = (raw ?? {}) as Record<string, unknown>;
      const relationPart = this.numOrStr(el, ['relationid', 'relationId', 'RelationID']) ?? payloadDigest(el);
      const stateToken = this.numOrStr(el, ['durum', 'state', 'status']) ?? payloadDigest(el);
      return { el, externalId: `${relationPart}:${stateToken}` };
    });

    const fresh = await this.archiveFresh(workspaceId, 'voice-report', rows);
    if (fresh.length === 0) return { ok: true };

    for (const r of fresh) {
      const relationid = this.numOrStr(r.el, ['relationid', 'relationId', 'RelationID']);
      if (!relationid) {
        this.logger.warn(`voice-report: element ${r.externalId} has no relationid — archived, not published`);
        continue;
      }
      const state = this.numOrStr(r.el, ['durum', 'state', 'status']);
      const bilsec = this.numberField(r.el, ['bilsec', 'talksec', 'duration', 'sure']);
      const pushButton = this.numOrStr(r.el, ['push_button', 'pushbutton', 'pushButton', 'tus', 'tuş']);
      const recordLink = this.stringField(r.el, ['record_link', 'recordlink', 'recordLink', 'recordingUrl']);

      await this.outbox.append({
        type: 'marketing.voice.report.v1',
        tenantId: null,
        payload: {
          workspaceId,
          relationid,
          state: state ?? null,
          bilsec,
          pushButton: pushButton ?? null,
          recordLink: recordLink ?? null,
        },
        idempotencyKey: `${workspaceId}:voice-report:${r.externalId}`,
      });
    }

    return { ok: true };
  }

  /**
   * Auto-dialer per-attempt report push (NetGSM Phase 5 Task 5). Body shape
   * per the facts: `{JobID, called, unique_id, status}` — one push per call
   * ATTEMPT (a number can be retried `retry_count` times, each attempt its
   * own `unique_id`), may arrive as a lone object or an array, same tolerant
   * shape as `events`/`voice-report` above.
   *
   * Archive key is `${jobIdPart}:${uniqueIdPart}` — `unique_id` already
   * identifies ONE attempt uniquely (unlike voice-report's `relationid`,
   * which can receive multiple distinct-state pushes for the SAME call), so
   * no extra state-token scoping is needed: a genuine redelivery of the same
   * attempt dedupes to one archived row, and every distinct attempt (a retry,
   * or a different number) gets its own.
   *
   * Correlates purely by `JobID` (= `AutocallClient.addAutocall`'s returned
   * `jobId`/`listId`, best-effort assumed to be the SAME identifier echoed
   * back here — NOT live-verified, see AutocallClient's docstring) — an
   * element with no resolvable JobID is archived for audit but never
   * published, same fail-closed treatment as every other route on this
   * controller (business-logic free: AutocallReportConsumer, not this
   * controller, resolves the session/lead).
   */
  @Post(':workspaceId/:token/autocall-report')
  @HttpCode(202)
  @SkipThrottle()
  async autocallReport(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'autocall-report', token)) throw new NotFoundException();
    const elements = Array.isArray(body) ? body : [body ?? {}];
    if (elements.length === 0) return { ok: true };

    const rows: WebhookRow[] = elements.map((raw) => {
      const el = (raw ?? {}) as Record<string, unknown>;
      const jobPart = this.numOrStr(el, ['JobID', 'jobid', 'jobId', 'listid', 'listId']) ?? payloadDigest(el);
      const uniquePart = this.numOrStr(el, ['unique_id', 'uniqueid', 'uniqueId']) ?? payloadDigest(el);
      return { el, externalId: `${jobPart}:${uniquePart}` };
    });

    const fresh = await this.archiveFresh(workspaceId, 'autocall-report', rows);
    if (fresh.length === 0) return { ok: true };

    for (const r of fresh) {
      const jobId = this.numOrStr(r.el, ['JobID', 'jobid', 'jobId', 'listid', 'listId']);
      if (!jobId) {
        this.logger.warn(`autocall-report: element ${r.externalId} has no JobID — archived, not published`);
        continue;
      }
      const called = this.stringField(r.el, ['called', 'no', 'number']);
      const uniqueId = this.numOrStr(r.el, ['unique_id', 'uniqueid', 'uniqueId']);
      const status = this.stringField(r.el, ['status', 'durum']);

      await this.outbox.append({
        type: 'marketing.autocall.report.v1',
        tenantId: null,
        payload: { workspaceId, jobId, called: called ?? null, uniqueId: uniqueId ?? null, status: status ?? null },
        idempotencyKey: `${workspaceId}:autocall-report:${r.externalId}`,
      });
    }

    return { ok: true };
  }

  /**
   * Shared read-existing→insert-missing fan-out helper for both array-shaped
   * (`iys`) and array-or-wrapped-object-shaped (`events`) batches. `createMany`
   * alone can't report WHICH rows were new (it only returns a count), so
   * existing externalIds for this batch are read FIRST — only the rows that
   * come back missing are archived AND returned to the caller for
   * publishing. `createMany({skipDuplicates: true})` remains the insert call
   * (the race backstop for a concurrent redelivery of the same batch); each
   * route's own publish step is further protected by `OutboxService.append`'s
   * idempotencyKey dedup, so even a genuine concurrent double-publish
   * attempt collapses to one outbox row.
   */
  private async archiveFresh(
    workspaceId: string,
    purpose: WebhookPurpose,
    rows: WebhookRow[],
  ): Promise<WebhookRow[]> {
    const existing = await this.prisma.netgsmWebhookEvent.findMany({
      where: { workspaceId, purpose, externalId: { in: rows.map((r) => r.externalId) } },
      select: { externalId: true },
    });
    const existingIds = new Set(existing.map((e) => e.externalId));
    const fresh = rows.filter((r) => !existingIds.has(r.externalId));
    if (fresh.length === 0) return [];

    await this.prisma.netgsmWebhookEvent.createMany({
      data: fresh.map((r) => ({ workspaceId, purpose, externalId: r.externalId, payload: r.el as object })),
      skipDuplicates: true,
    });

    return fresh;
  }

  /**
   * `events`-route only — see the CRITICAL note on `events()` above. Prefers
   * the raw scenario/durum/event field value (lowercased/trimmed) so
   * Inbound_call/Answer/Hangup/cdr — and any future/unrecognized scenario
   * string — each get their own token; falls back to the normalized `kind`
   * (currently unreachable in practice, since `normalizeSantralEvent` reads
   * the same three keys, but kept as a defensive second tier in case the
   * normalizer's field detection ever widens); finally falls back to a
   * digest of the whole element so two elements with no scenario field at
   * all, sharing the same unique_id, still don't collide into one archive
   * row.
   */
  private scenarioToken(el: Record<string, unknown>): string {
    const raw = this.stringField(el, ['scenario', 'durum', 'event']);
    if (raw) return raw.trim().toLowerCase();
    return normalizeSantralEvent(el)?.kind ?? payloadDigest(el);
  }

  private stringField(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  }

  /**
   * `voice-report`-route only — like `stringField`, but also accepts a bare
   * JSON number (stringified), since NetGSM's voicesms report may carry
   * `durum`/`push_button`/`relationid` as either a string or a number (the
   * exact wire shape isn't live-verified — see `voiceReport`'s docstring).
   */
  private numOrStr(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
  }

  /** `voice-report`-route only — `bilsec` (talk seconds) read as a real
   *  number regardless of whether NetGSM sends it as a JSON number or a
   *  numeric string. Returns null when absent/unparseable. */
  private numberField(obj: Record<string, unknown>, keys: string[]): number | null {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }
}
