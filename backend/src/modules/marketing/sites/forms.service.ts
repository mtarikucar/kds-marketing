import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { AffiliateService } from '../services/affiliate.service';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { normalizeEmail, normalizePhone, localMsisdnVariants } from '../utils/lead-normalize';
import { isSingleAddress } from '../../../common/util/email-address';
import { classifyEmailSyntax } from '../leads/email-hygiene.service';
import { ConsentLedgerService } from '../compliance/consent-ledger.service';

/** One field as the builder stores it (`FormDef.fields` is untyped JSON). */
interface FormFieldDef {
  name?: string;
  label?: string;
  type?: string;
  options?: unknown;
  /** Explicit marker: this box is marketing consent, whatever it is labelled. */
  consent?: boolean;
}

/**
 * Fold a builder key or a label into one comparable token.
 *
 * The POST key is slugified from the LABEL ("E-posta" → `e_posta`), so the two
 * are the same string in different shapes and both have to match the same
 * vocabulary. Turkish diacritics are folded to ASCII because a tenant writes
 * "E-Posta", "e posta" and "EPOSTA" and means one field. `ı` is mapped first:
 * it has no decomposition, so NFKD alone would leave it un-foldable.
 */
function normKey(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Label/key vocabularies — the LAST resort, after the literal key and the
 * declared type. Exact whole-token matches only: a `contains` rule would read
 * "e-posta izni" (a consent checkbox) as the address field.
 */
const EMAIL_KEYS = new Set([
  'email', 'e_mail', 'mail', 'eposta', 'e_posta', 'email_adresi', 'eposta_adresi',
  'e_posta_adresi', 'e_posta_adresiniz', 'mail_adresi', 'elektronik_posta',
]);
const PHONE_KEYS = new Set([
  'phone', 'tel', 'telefon', 'gsm', 'cep', 'cep_telefonu', 'mobile', 'mobil',
  'telefon_numarasi', 'telefon_no', 'numara', 'gsm_no',
]);
const NAME_KEYS = new Set([
  'name', 'fullname', 'full_name', 'contact', 'contact_person', 'contactperson',
  'ad', 'isim', 'ad_soyad', 'adsoyad', 'ad_ve_soyad', 'adiniz', 'isminiz',
  'yetkili', 'yetkili_kisi',
]);

/**
 * What makes an option-less checkbox a MARKETING consent box rather than a
 * terms-acceptance box. Deliberately narrow: recording a "kullanım koşullarını
 * kabul ediyorum" tick as `MARKETING_EMAIL` consent would misstate what the
 * person agreed to, which is the one thing a consent ledger must never do.
 */
const CONSENT_WORDS = [
  'consent', 'izin', 'kvkk', 'subscribe', 'abone', 'newsletter', 'bulten',
  'marketing', 'pazarlama', 'optin', 'opt_in', 'permission', 'ticari', 'kampanya',
];

/** How many digits a real phone number has (E.164 caps at 15). */
const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;

/**
 * What one visitor may mint through one form before we stop believing them.
 *
 * The route already sits behind a 20/min per-IP throttle, which bounds the
 * RATE but not the total: a patient script still writes a lead — and fires the
 * workflow that mails it — every three seconds, indefinitely. Exceeding this
 * drops the submission silently and still returns the ordinary thank-you, so a
 * script learns nothing from the response.
 *
 * The number is high on purpose. Turkish mobile carriers are behind CGNAT, so
 * a genuinely busy landing page CAN put dozens of real visitors on one source
 * address, and a cap that eats real leads is a worse bug than the one it
 * prevents. A hundred submissions to ONE form from ONE address inside ten
 * minutes is not a NAT pool.
 */
export const FORM_BURST_LIMIT = 100;
const FORM_BURST_WINDOW_MS = 10 * 60_000;
/** Bound on the in-process bookkeeping itself, so the map cannot grow forever. */
const FORM_BURST_MAX_KEYS = 5_000;

/**
 * Public form submission → lead. Resolves the workspace from the FormDef,
 * de-dupes the lead by email/phone, and emits form.submitted (a workflow
 * trigger). Returns the redirect URL for the post/redirect/get flow.
 */
@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);
  private readonly sentinelCache = new Map<string, string | null>();
  /** (formId, ip) → recent submission timestamps. See FORM_BURST_LIMIT. */
  private readonly burst = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly affiliates: AffiliateService,
    private readonly leadAttribution: LeadAttributionService,
    private readonly consentLedger: ConsentLedgerService,
  ) {}

  async submit(
    formId: string,
    data: Record<string, string>,
    affRef?: string,
    ctx?: { url?: string | null; referrer?: string | null; ip?: string | null },
  ): Promise<{ redirectUrl: string | null }> {
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
    // `fields` is untyped JSON and rows predate the builder's schema, so this
    // has to survive a missing or non-array value rather than throw on it.
    const fields: FormFieldDef[] = Array.isArray((form as { fields?: unknown }).fields)
      ? ((form as { fields?: unknown }).fields as FormFieldDef[]).filter((f) => f && typeof f === 'object')
      : [];

    if (this.burstExceeded(formId, ctx?.ip)) {
      this.logger.warn(`form ${formId}: submission burst from one address dropped`);
      return { redirectUrl: form.redirectUrl ?? null };
    }

    const name = this.resolveField(data, fields, ['name', 'fullName', 'contactPerson'], null, NAME_KEYS);
    const rawEmail = this.resolveField(data, fields, ['email'], 'email', EMAIL_KEYS);
    const rawPhone = this.resolveField(data, fields, ['phone', 'tel'], 'tel', PHONE_KEYS);
    // A stranger typed this. One address or none: a list here used to become
    // `lead.email`, and the workflow that answers a form submission then handed
    // that string to a transport — the tenant's own mailbox relaying mail the
    // visitor wrote, to recipients the visitor chose. Deliberately NOT a 400,
    // because a typo would then lose a real lead: the value is left out of the
    // identity fields and stays visible in the submission note for a rep.
    const email = rawEmail && isSingleAddress(rawEmail) ? rawEmail : null;
    // `normalizePhone` is a bare digit-strip, so `a,b,c…` collapses into one
    // 150-digit blob that the SMS and voice lanes would then try to dial.
    const phone = rawPhone && this.isDialable(rawPhone) ? rawPhone : null;
    // Canonical dedup keys — match the manual-create path so a form submit and a
    // hand-entered lead with the same (case/format-varying) email/phone collide.
    const emailNormalized = normalizeEmail(email);
    const phoneNormalized = normalizePhone(phone);
    const businessName = (data.businessName || data.company || name || 'Form lead').trim();
    const consent = this.resolveConsent(data, fields);
    const dropped: string[] = [];
    if (rawEmail && !email) dropped.push('email');
    if (rawPhone && !phone) dropped.push('phone');

    const { leadId, created } = await this.prisma.$transaction(async (tx) => {
      // De-dupe on the NORMALIZED keys, skipping tombstoned (merged-away) leads
      // so a merge can't be resurrected by a later submission.
      let existing = null as { id: string; status: string } | null;
      if (emailNormalized || phoneNormalized) {
        existing = await tx.lead.findFirst({
          where: {
            workspaceId,
            mergedIntoId: null,
            // Exclude soft-deleted (bulk-deleted) leads too — otherwise a new
            // website inquiry from a previously-deleted contact attaches to that
            // still-hidden record and never surfaces in the sales team's list.
            deletedAt: null,
            OR: [
              ...(emailNormalized ? [{ emailNormalized }] : []),
              // Match every stored spelling of the number (0- / bare / 90- / +90 /
              // 00-), like İYS/telephony/leadgen do — an exact match would miss a
              // lead first stored in a different format and duplicate it.
              ...(phoneNormalized ? [{ phoneNormalized: { in: localMsisdnVariants(phoneNormalized) } }] : []),
            ],
          },
          select: { id: true, status: true },
        });
      }
      let leadId: string;
      let created: boolean;
      if (existing) {
        // A re-engagement signal for an OPEN lead — but never overwrite a closed
        // (WON/LOST) lead's original source.
        if (existing.status !== 'WON' && existing.status !== 'LOST') {
          await tx.lead.updateMany({ where: { id: existing.id, workspaceId }, data: { source: 'WEBSITE' } });
        }
        leadId = existing.id;
        created = false;
      } else {
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
            // Hygiene at the write, syntax only — this answers a visitor's POST
            // and cannot spend a DNS round trip on it. It costs nothing and it
            // is what surfaces a throwaway address before a campaign finds it.
            ...(email ? { emailVerifiedStatus: classifyEmailSyntax(email) } : {}),
            ...(autoOwner ? { assignedToId: autoOwner } : {}),
          },
        });
        const sentinel = await this.resolveSentinel(workspaceId);
        if (sentinel) {
          await tx.leadActivity.create({
            data: { leadId: lead.id, type: 'NOTE', title: `Form submission: ${form.name}`, description: this.summarize(data, dropped), createdById: sentinel },
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
        // First-touch attribution for the NEW lead, in the SAME tx so it's as
        // durable as the lead. Best-effort — never blocks capture (the service
        // swallows its own errors).
        await this.leadAttribution.capture(
          workspaceId,
          lead.id,
          { url: ctx?.url, referrer: ctx?.referrer, fields: data },
          {},
          tx,
        );
        leadId = lead.id;
        created = true;
      }
      // FormSubmitted in the SAME tx as the lead write → the form.submitted
      // workflow trigger is durable iff the lead row is (matches LeadCreated).
      // The old after-commit emit had no try/catch, so an outbox blip 500'd the
      // visitor AFTER their lead was saved, and the trigger was lost forever (the
      // next dedup'd submit returns the existing lead without re-emitting).
      await this.outbox.append(
        {
          type: MarketingEventTypes.FormSubmitted,
          idempotencyKey: `form-submitted:${formId}:${leadId}:${Date.now()}`,
          payload: { workspaceId, leadId, formId, fields: data, occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
      // Consent at source, in the SAME tx as the lead — what was ticked, from
      // which address, against which words. A record that could outlive a
      // rolled-back lead (or be lost while the lead commits) would be an audit
      // trail nobody can rely on, which is worse than none.
      if (consent) {
        await this.consentLedger.record(
          {
            workspaceId,
            leadIds: [leadId],
            type: 'MARKETING_EMAIL',
            granted: consent.granted,
            // The snapshot is the text the visitor READ. Keeping only
            // `form:<id>` would let a later edit of the wording silently
            // rewrite what everyone before it agreed to. The `form:<id>`
            // prefix stays first so the source is still matchable.
            source: `form:${formId}${consent.text ? ` :: ${consent.text}` : ''}`,
            ipAddress: ctx?.ip ?? null,
          },
          tx,
        );
      }
      return { leadId, created };
    });

    // Affiliate attribution: a NEW lead carrying an aff_ref referral cookie is
    // credited to the referring affiliate (same-workspace + ACTIVE only). Best-
    // effort — never blocks lead capture.
    if (created && affRef) {
      await this.affiliates.attributeReferral(workspaceId, affRef, leadId);
    }

    return { redirectUrl: form.redirectUrl ?? null };
  }

  /**
   * Which submitted value is the email / phone / name.
   *
   * Three passes, in this order and no other:
   *  1. the LITERAL keys (`email`, `phone`, `name`, …) — every English form and
   *     the seeded default form must keep behaving byte-identically, so a
   *     builder-typed field can never outrank the contractual key;
   *  2. the declared field TYPE (`email`, `tel`) in DECLARATION order — a form
   *     with "E-posta" and "E-posta tekrar" must resolve deterministically, not
   *     by whichever key the POST body happened to enumerate first;
   *  3. a label/key synonym, for the fields that carry no distinguishing type
   *     (`name` above all — there is no `type: 'name'`).
   */
  private resolveField(
    data: Record<string, string>,
    fields: FormFieldDef[],
    literalKeys: string[],
    type: string | null,
    synonyms: Set<string>,
  ): string | null {
    for (const k of literalKeys) {
      const v = (data[k] ?? '').trim();
      if (v) return v;
    }
    if (type) {
      for (const f of fields) {
        if (normKey(f.type) !== type) continue;
        const v = (data[String(f.name ?? '')] ?? '').trim();
        if (v) return v;
      }
    }
    for (const f of fields) {
      if (!synonyms.has(normKey(f.name)) && !synonyms.has(normKey(f.label))) continue;
      const v = (data[String(f.name ?? '')] ?? '').trim();
      if (v) return v;
    }
    return null;
  }

  /** A value `normalizePhone` can turn into something dialable, not a blob. */
  private isDialable(raw: string): boolean {
    const digits = normalizePhone(raw);
    return !!digits && digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
  }

  /**
   * The form's marketing-consent checkbox, and whether it was ticked.
   *
   * Returns null when the form declares none — which is every form that exists
   * today, so nothing changes for an existing tenant until they add the box.
   * An UNTICKED declared box is a recorded refusal, not silence: an unchecked
   * checkbox is simply not posted, so "absent" is the answer, and an answer is
   * what the ledger is for.
   */
  private resolveConsent(
    data: Record<string, string>,
    fields: FormFieldDef[],
  ): { granted: boolean; text: string } | null {
    const field = fields.find((f) => this.isConsentField(f));
    if (!field) return null;
    const raw = (data[String(field.name ?? '')] ?? '').trim().toLowerCase();
    const granted = !!raw && !['0', 'false', 'no', 'off', 'hayir', 'hayır'].includes(raw);
    return { granted, text: String(field.label ?? field.name ?? '').slice(0, 300) };
  }

  private isConsentField(f: FormFieldDef): boolean {
    if (f.consent === true) return true;
    const type = normKey(f.type);
    if (type === 'consent') return true;
    // An options list makes it a multi-select, not the single box the renderer
    // draws for consent.
    if (type !== 'checkbox' || (Array.isArray(f.options) && f.options.length > 0)) return false;
    const token = `${normKey(f.name)}_${normKey(f.label)}`;
    return CONSENT_WORDS.some((w) => token.includes(w));
  }

  /**
   * Has this (form, address) pair submitted too often lately?
   *
   * Inert without an IP: a caller that cannot say who submitted keeps today's
   * behaviour exactly. In-process on purpose — this is a cheap bound on one
   * box's share of an abusive burst, not a distributed quota; the durable
   * limits are the route throttle and the single-address rule above.
   */
  private burstExceeded(formId: string, ip?: string | null): boolean {
    if (!ip) return false;
    const now = Date.now();
    // Wholesale reset rather than an LRU: the map only grows under abuse, and
    // dropping it costs at most one window of leniency.
    if (this.burst.size > FORM_BURST_MAX_KEYS) this.burst.clear();
    const key = `${formId}|${ip}`;
    const recent = (this.burst.get(key) ?? []).filter((t) => now - t < FORM_BURST_WINDOW_MS);
    if (recent.length >= FORM_BURST_LIMIT) {
      this.burst.set(key, recent);
      return true;
    }
    recent.push(now);
    this.burst.set(key, recent);
    return false;
  }

  private summarize(data: Record<string, string>, dropped: string[] = []): string {
    const lines = Object.entries(data)
      .filter(([k]) => !['_csrf'].includes(k))
      .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`);
    // Say WHY the lead has no email/phone, next to the value that was refused —
    // otherwise the field just looks empty and nobody repairs it.
    if (dropped.length) lines.push(`(not stored — not a single usable value: ${dropped.join(', ')})`);
    return lines.join('\n').slice(0, 2000);
  }

  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    if (this.sentinelCache.has(workspaceId)) return this.sentinelCache.get(workspaceId)!;
    const row = await this.prisma.marketingUser.findFirst({ where: { workspaceId, role: 'SYSTEM' }, select: { id: true } });
    const id = row?.id ?? null;
    this.sentinelCache.set(workspaceId, id);
    return id;
  }
}
