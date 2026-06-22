import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Only the sha256 of a webhook secret is ever stored (mirrors IngestTokenGuard). */
export function hashWebhookSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface CreateInboundWebhookInput {
  name: string;
}
export interface UpdateInboundWebhookInput {
  name?: string;
  enabled?: boolean;
}

/**
 * Inbound webhooks (GoHighLevel parity). An external system POSTs JSON to the
 * public hook URL identified by a globally-unique `slug`; the `x-webhook-secret`
 * header (or `?secret=`) authenticates by sha256 match. Each accepted POST emits
 * a `marketing.webhook.received.v1` event that fires `webhook.received`
 * workflows, with the posted body carried under `payload.body` and the lead
 * resolved (best-effort) by email/phone so workflows can target a contact.
 *
 * The raw secret is shown ONCE at mint/rotate time and never stored in clear —
 * exactly the ingest-token posture. CRUD is workspace-scoped; the public
 * receive path resolves by the globally-unique slug (findUnique — exempt).
 */
@Injectable()
export class InboundWebhooksService {
  private readonly logger = new Logger(InboundWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
  }

  /** The public POST URL for a slug (what the admin UI copies). */
  publicUrl(slug: string): string {
    return `${this.baseUrl()}/api/public/hooks/${slug}`;
  }

  private shape(w: { id: string; name: string; slug: string; enabled: boolean; lastReceivedAt: Date | null; receivedCount: number; createdAt: Date }) {
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      enabled: w.enabled,
      lastReceivedAt: w.lastReceivedAt,
      receivedCount: w.receivedCount,
      createdAt: w.createdAt,
      url: this.publicUrl(w.slug),
    };
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.inboundWebhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.shape(r));
  }

  /** Mint a webhook. The raw secret is returned ONCE here and never again. */
  async create(workspaceId: string, dto: CreateInboundWebhookInput) {
    const slug = randomBytes(12).toString('hex');
    const secret = WEBHOOK_SECRET_PREFIX + randomBytes(24).toString('hex');
    const w = await this.prisma.inboundWebhook.create({
      data: { workspaceId, name: dto.name, slug, secretHash: hashWebhookSecret(secret) },
    });
    return { ...this.shape(w), secret };
  }

  async update(workspaceId: string, id: string, dto: UpdateInboundWebhookInput) {
    const res = await this.prisma.inboundWebhook.updateMany({
      where: { id, workspaceId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    if (res.count === 0) throw new NotFoundException('Webhook not found');
    // Re-read can race a concurrent same-tenant delete; treat a vanished row as
    // a clean 404 rather than dereferencing null (no `!` assertion).
    const w = await this.prisma.inboundWebhook.findFirst({ where: { id, workspaceId } });
    if (!w) throw new NotFoundException('Webhook not found');
    return this.shape(w);
  }

  /** Rotate the secret (invalidates the old one). Returns the new raw secret once. */
  async rotateSecret(workspaceId: string, id: string) {
    const secret = WEBHOOK_SECRET_PREFIX + randomBytes(24).toString('hex');
    const res = await this.prisma.inboundWebhook.updateMany({
      where: { id, workspaceId },
      data: { secretHash: hashWebhookSecret(secret) },
    });
    if (res.count === 0) throw new NotFoundException('Webhook not found');
    const w = await this.prisma.inboundWebhook.findFirst({ where: { id, workspaceId } });
    if (!w) throw new NotFoundException('Webhook not found');
    return { ...this.shape(w), secret };
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.inboundWebhook.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Webhook not found');
    return { message: 'Webhook deleted' };
  }

  /**
   * Resolve a webhook by its public slug for the guard. Globally-unique slug →
   * findUnique (no workspace context on the public path). Returns null when
   * absent OR disabled so the guard 401s uniformly (no enabled/exists oracle).
   */
  async resolveActive(slug: string) {
    const w = await this.prisma.inboundWebhook.findUnique({ where: { slug } });
    if (!w || !w.enabled) return null;
    return w;
  }

  /**
   * Record an accepted delivery: resolve the lead (best-effort, by email/phone
   * in the body), bump counters, and emit the workflow-trigger event. Called by
   * the public controller AFTER the guard has authenticated the secret.
   */
  async receive(
    webhook: { id: string; workspaceId: string; slug: string },
    body: unknown,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ received: true; leadId: string | null }> {
    const { email, phone } = extractContact(body);
    const leadId = await this.resolveLeadId(webhook.workspaceId, email, phone);

    // best-effort telemetry; never blocks the receive
    await this.prisma.inboundWebhook
      .updateMany({
        where: { id: webhook.id, workspaceId: webhook.workspaceId },
        data: { lastReceivedAt: new Date(), receivedCount: { increment: 1 } },
      })
      .catch((e) => this.logger.warn(`webhook counter bump failed: ${e?.message ?? e}`));

    // A distinct delivery per call. If the sender supplied a delivery id we use
    // it (real dedup on their retries); otherwise a per-call random key — every
    // delivery fires exactly once (the desired webhook semantic), and it is an
    // explicit key so the dedup-required warning doesn't trip.
    const idempotencyKey = `webhook-received:${webhook.id}:${opts.idempotencyKey ?? randomBytes(12).toString('hex')}`;
    await this.outbox.append({
      type: MarketingEventTypes.WebhookReceived,
      idempotencyKey,
      tenantId: webhook.workspaceId,
      payload: {
        workspaceId: webhook.workspaceId,
        leadId,
        webhookId: webhook.id,
        slug: webhook.slug,
        body: sanitizeBody(body),
        receivedAt: new Date().toISOString(),
      },
    });

    return { received: true, leadId };
  }

  private async resolveLeadId(workspaceId: string, email?: string, phone?: string): Promise<string | null> {
    if (!email && !phone) return null;
    const or: any[] = [];
    if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
    if (phone) {
      or.push({ phone });
      or.push({ whatsapp: phone });
    }
    const lead = await this.prisma.lead.findFirst({
      where: { workspaceId, OR: or },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return lead?.id ?? null;
  }
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Cap the stored/forwarded body so a hostile sender can't bloat the outbox. */
const MAX_BODY_BYTES = 32_768;

export function sanitizeBody(body: unknown): unknown {
  try {
    const json = JSON.stringify(body ?? null);
    if (json.length > MAX_BODY_BYTES) {
      return { _truncated: true, _bytes: json.length };
    }
    return body ?? null;
  } catch {
    return { _unserializable: true };
  }
}

const EMAIL_KEYS = ['email', 'e_mail', 'mail', 'emailaddress', 'email_address'];
const PHONE_KEYS = ['phone', 'phonenumber', 'phone_number', 'tel', 'telephone', 'mobile', 'msisdn'];

/**
 * Best-effort email/phone extraction from an arbitrary webhook body. Scans the
 * top level plus one level of common wrapper objects (contact/lead/data/payload)
 * — enough for Zapier/Make/typeform-style payloads without walking untrusted
 * JSON arbitrarily deep.
 */
export function extractContact(body: unknown): { email?: string; phone?: string } {
  const out: { email?: string; phone?: string } = {};
  const scan = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const key = k.toLowerCase();
      if (!out.email && EMAIL_KEYS.includes(key)) out.email = v.trim();
      if (!out.phone && PHONE_KEYS.includes(key)) out.phone = v.trim();
    }
  };
  scan(body);
  if (body && typeof body === 'object') {
    for (const wrapper of ['contact', 'lead', 'data', 'payload']) {
      scan((body as any)[wrapper]);
    }
  }
  return out;
}
