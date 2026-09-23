import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../common/crypto/secret-box.helper';
import { metaGraphFetch, graphApiVersion } from '../../../common/util/meta-graph.util';
import { withTimeout } from '../../../common/util/with-timeout';
import { EntitlementsService, FeatureKey } from '../../billing/entitlements.service';
import { ChannelAdapterRegistry, ChannelRowLike } from './channel-adapter.registry';
import { PublicChannelResolverService } from './public-channel-resolver.service';
import { MailboxHealthService } from './mailbox-health.service';
import { mergeConfigPublic } from './config-public.merge';
import { assertEmailSecrets } from './email-config.util';
import { emailInboundCallbackUrl } from './email-inbound-callback.util';
import { NEW_CHANNEL_INBOUND_POLICY } from './inbound/inbound-policy';
import { classifySmtpError } from './outbound/smtp-error';
import { domainOf } from './smtp-autodiscover';
import { assertNetgsmSmsSecrets } from './netgsm-config.util';
import { assertTiktokDmSecrets } from './tiktok-config.util';
import { netgsmMoCallbackUrl } from './netgsm-callback.util';
import { assertMetaSecrets, isMetaChannelType } from './meta-config.util';
import { metaWebhookCallbackUrl } from './meta-callback.util';
import { assertLinkedinEngagementSecrets } from './linkedin-config.util';
import { tiktokWebhookCallbackUrl } from './tiktok-callback.util';
import { IysClient } from '../../netgsm/iys/iys.client';
import { netgsmWebhookUrl } from '../../netgsm/webhooks/netgsm-webhook.util';

/**
 * How an EMAIL channel proved it owns the address it is claiming.
 *
 * `'oauth'` is the provider's own answer to "whose mailbox is this" and is
 * NEVER derivable from the payload: `secrets` is a free-form object on the
 * public DTO, so a caller can seal `oauthProvider` next to any address it
 * likes. Only an in-process caller that actually completed the consent flow
 * may pass this, which the global `forbidNonWhitelisted` ValidationPipe makes
 * true by construction — an HTTP body carrying `addressProof` is a 400.
 */
export type EmailAddressProof = 'oauth';

export interface CreateChannelInput {
  type: string;
  name: string;
  agentProfileId?: string | null;
  externalId?: string | null;
  secrets?: Record<string, string>;
  configPublic?: Record<string, unknown>;
  /** Internal only — see `EmailAddressProof`. Never reachable from the API. */
  addressProof?: EmailAddressProof;
}
export interface UpdateChannelInput {
  name?: string;
  status?: string;
  agentProfileId?: string | null;
  externalId?: string | null;
  secrets?: Record<string, string>;
  /**
   * Secret keys to DROP in this write. `secrets` merges, so it can set a key
   * and never unset one — which is right for a rotate-one-field edit and wrong
   * when a channel switches how it authenticates: connecting a mailbox by
   * consent must leave no SMTP password sealed behind the live token.
   * Opt-in, so no existing caller starts deleting keys by omission.
   */
  clearSecretKeys?: string[];
  configPublic?: Record<string, unknown>;
  /** Internal only — see `EmailAddressProof`. Never reachable from the API. */
  addressProof?: EmailAddressProof;
}

/**
 * A health check that was run, and whether we got an ANSWER at all.
 *
 * `reached` is the difference between "the mail server refused these
 * credentials" and "nothing answered": the first is grounds for unplugging a
 * mailbox, the second is a DNS blip that must not stop every reply arriving.
 */
interface HealthOutcome {
  ok: boolean;
  details?: Record<string, unknown>;
  reached: boolean;
}

/**
 * How long a SAVE may wait on a mail server before it stops being a save.
 *
 * The SMTP branch allows 15s each for connection, greeting and socket, and
 * then probes IMAP, so an unbounded check could hold `POST /channels` open for
 * the better part of a minute over nothing but a typo in the host.
 */
const CONNECT_CHECK_TIMEOUT_MS = 10_000;

/** What the plan item is CALLED, so a refusal can name it instead of saying
 *  "a higher package" and leaving the owner to guess which switch to find. */
const FEATURE_LABEL: Partial<Record<FeatureKey, string>> = {
  conversationAi: 'Conversations & Inbox',
  campaigns: 'Campaigns',
  sms: 'SMS',
  telephony: 'Telephony',
};

/**
 * Channel CRUD + verify. Secrets are AES-256-GCM sealed into `configSealed`
 * (never returned raw — reads expose only WHICH keys are set). A web-chat
 * channel gets a public `widgetKey` minted on create (embedded in widget.js).
 * `verify` resolves the (decrypted) config and runs the adapter's healthCheck.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly resolver: PublicChannelResolverService,
    private readonly entitlements: EntitlementsService,
    private readonly iysClient: IysClient,
    private readonly mailboxHealth: MailboxHealthService,
  ) {}

  /**
   * Per-type feature gate for channel save/verify. Channel CRUD is one generic
   * surface across every type, so the controller can't statically decide the
   * key — SMS requires `sms` (split off `conversationAi` for the NetGSM SMS v2
   * program); every other type keeps requiring `conversationAi`, unchanged.
   */
  private async assertChannelFeature(workspaceId: string, type: string): Promise<void> {
    // The gate STAYS where it is, deliberately. Moving EMAIL onto its own key
    // would change create/update/verify and nothing else: the channel list, the
    // delete route and every `marketing-conversations.controller.ts` method
    // carry `@RequiresFeature('conversationAi')` of their own, so the workspace
    // would end up with a mailbox it can connect and cannot see — connect
    // succeeds, inbox 403s, and inbound mail is written into a surface nobody
    // can open. A clean refusal that NAMES the missing plan item is the honest
    // half of `email-gated-conversationai`; the other half is an operator
    // granting the package (PLAN §E #1).
    // VOICE is gated on `telephony`, the same key the /calls nav item, the
    // webphone, the dialer and NetGSM onboarding all use — not on
    // `conversationAi`. Falling through to the default would have let a
    // workspace with conversationAi and no telephony create a voice channel it
    // cannot use, while refusing one to a telephony workspace that has it.
    const feature: FeatureKey =
      type === 'SMS' ? 'sms' : type === 'VOICE' ? 'telephony' : 'conversationAi';
    await this.assertFeature(workspaceId, feature);
  }

  /** Shared single-key entitlement check — assertChannelFeature() picks the
   *  per-type key then delegates here; registerIysWebhook() calls this
   *  directly with a fixed key (`campaigns`, see its own doc comment). */
  private async assertFeature(workspaceId: string, feature: FeatureKey): Promise<void> {
    const effective = await this.entitlements.getEffective(workspaceId);
    if (!effective.features[feature]) {
      const label = FEATURE_LABEL[feature];
      throw new ForbiddenException({
        // The panel localises off `code`; this sentence is the fallback, and it
        // has to be actionable on its own — "requires a higher package" sent
        // the live workspace looking for a switch it could not name.
        message: label
          ? `This needs the "${label}" plan item, which this workspace's package does not include.`
          : `This needs the "${feature}" plan item, which this workspace's package does not include.`,
        feature,
        ...(label ? { featureLabel: label } : {}),
        code: 'FEATURE_NOT_IN_PACKAGE',
      });
    }
  }

  /** Canonical externalId for a type. EMAIL addresses are case-insensitive, so
   *  store them lower-cased+trimmed — the inbound webhook lower-cases the To
   *  address before resolving, so the two sides must agree. */
  private normalizeExternalId(type: string, externalId: string | null | undefined): string | null {
    if (externalId == null) return null;
    const v = externalId.trim();
    if (!v) return null;
    return type === 'EMAIL' ? v.toLowerCase() : v;
  }

  /** Reject registering a provider identity (type, externalId) another channel
   *  already owns — even in another workspace, and REGARDLESS of that channel's
   *  status. anyByExternalId is the sanctioned cross-workspace read; without
   *  this two tenants could claim the same inbound address and the webhook
   *  would deliver to whichever findFirst returns (cross-tenant mail).
   *
   *  This used to ask byExternalId, which filters ACTIVE. That made a DISABLED
   *  channel's identity look free, and the whole sequence was reachable from
   *  the public API: register the victim's (public) page/phone id — `secrets`
   *  is optional, so no proof of control is needed — PATCH it to DISABLED so it
   *  stops blocking, wait for the real owner to connect, then PATCH back to
   *  ACTIVE. Two ACTIVE rows, one provider identity, and inbound messages land
   *  in whichever tenant Postgres happens to scan first. */
  private async assertExternalIdFree(type: string, externalId: string | null, excludeId?: string) {
    if (!externalId) return;
    const existing = await this.resolver.anyByExternalId(type, externalId);
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('That provider identity is already connected to a channel');
    }
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.channel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => this.mask(c));
  }

  async get(workspaceId: string, id: string) {
    const c = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Channel not found');
    return this.mask(c);
  }

  async create(workspaceId: string, dto: CreateChannelInput) {
    if (!this.registry.has(dto.type)) {
      throw new NotFoundException(`Unsupported channel type: ${dto.type}`);
    }
    await this.assertChannelFeature(workspaceId, dto.type);
    const hasSecrets = !!(dto.secrets && Object.keys(dto.secrets).length);
    // Before anything is sealed: a host that answers inside our own network, a
    // From that is prose, a port with a stray digit. The operator is still
    // looking at the form, which is the only moment the answer is useful.
    if (hasSecrets) await this.assertSecrets(dto.type, dto.secrets!);

    const requested = this.normalizeExternalId(dto.type, dto.externalId);

    // An address this workspace has already parked belongs to the row that
    // parked it. `EmailOAuthService` looks its channel up by `externalId`,
    // misses a parked row and lands here, so without this a reconnect would
    // leave the workspace with two channels for one mailbox — and the parked
    // row no longer collides on the unique index to stop it. Re-connecting
    // rotates the credentials and promotes the claim if proof arrived with it,
    // exactly as `completeWhatsappSignup` re-connects a phone number.
    if (requested) {
      const parked = await this.findParkedEmailChannel(workspaceId, dto.type, requested);
      if (parked) {
        return this.update(workspaceId, parked.id, {
          name: dto.name,
          status: 'ACTIVE',
          externalId: requested,
          ...(dto.addressProof ? { addressProof: dto.addressProof } : {}),
          ...(hasSecrets ? { secrets: dto.secrets } : {}),
        });
      }
    }

    const claim = await this.resolveEmailClaim(workspaceId, dto.type, requested, dto.addressProof);
    await this.assertExternalIdFree(dto.type, claim.externalId);
    const data: any = {
      workspaceId,
      type: dto.type,
      name: dto.name,
      status: 'ACTIVE',
      agentProfileId: dto.agentProfileId ?? null,
      externalId: claim.externalId,
      configPublic: this.initialConfigPublic(dto, claim.pendingAddress),
    };
    if (dto.type === 'WEBCHAT') {
      data.widgetKey = `wc_${randomBytes(16).toString('hex')}`;
    }
    if (hasSecrets) {
      data.configSealed = this.seal(dto.secrets!);
    }
    const c = await this.prisma.channel.create({ data: { ...data, workspaceId } });
    // Nothing to prove without credentials (a WEBCHAT has none), and the row
    // must survive whatever the proof attempt does — see `proveMailbox`.
    if (!hasSecrets) return this.mask(c);
    const proved = await this.proveMailbox(workspaceId, c, null);
    return { ...this.mask(proved.row), health: proved.health };
  }

  /**
   * Public, non-secret config the frontend needs to launch WhatsApp Embedded
   * Signup (the FB JS SDK FB.login config). `configured` is false when the
   * platform app id / signup configuration id are absent — the button stays
   * inert (the inert-feature rule), exactly like the SMS/Meta gates elsewhere.
   */
  whatsappSignupConfig(): {
    configured: boolean;
    appId: string | null;
    configId: string | null;
    graphVersion: string;
  } {
    const appId = process.env.META_APP_ID || null;
    const configId = process.env.META_WHATSAPP_CONFIG_ID || null;
    return { configured: !!(appId && configId), appId, configId, graphVersion: graphApiVersion() };
  }

  /**
   * Finish WhatsApp Embedded Signup for a TENANT (self-serve, no manual token
   * handling): exchange the short-lived `code` for a long-lived business token,
   * subscribe our app to the tenant's WABA (so inbound + status webhooks flow),
   * best-effort register the phone for Cloud API sending, then create — or
   * rotate the token of — the workspace's WHATSAPP channel. The token is sealed
   * by `create`/`update` and never returned. Reconnecting the same phone number
   * rotates the stored token.
   */
  async completeWhatsappSignup(
    workspaceId: string,
    input: { code?: string; wabaId?: string; phoneNumberId?: string },
  ) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new BadRequestException('WhatsApp sign-up is not configured on this platform');
    }
    if (!isSecretBoxConfigured()) {
      throw new ServiceUnavailableException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    const code = (input.code ?? '').trim();
    const wabaId = (input.wabaId ?? '').trim();
    const phoneNumberId = (input.phoneNumberId ?? '').trim();
    if (!code) throw new BadRequestException('Missing sign-up code');
    if (!phoneNumberId) throw new BadRequestException('Missing phoneNumberId');

    // 1) Exchange the code for a long-lived business-integration access token.
    const tok = await metaGraphFetch('/oauth/access_token', {
      query: { client_id: appId, client_secret: appSecret, code },
    });
    const accessToken: string | undefined = tok.ok ? tok.data?.access_token : undefined;
    if (!accessToken) {
      throw new BadRequestException(
        `WhatsApp token exchange failed: ${tok.error?.message ?? 'no access_token returned'}`,
      );
    }

    // 2) Subscribe our app to the tenant's WABA — without this, real inbound /
    //    delivery webhooks are never delivered to our callback.
    if (wabaId) {
      const sub = await metaGraphFetch(`/${wabaId}/subscribed_apps`, {
        accessToken,
        method: 'POST',
      });
      if (!sub.ok) {
        this.logger.warn(`WA signup: subscribe WABA ${wabaId} failed: ${sub.error?.message ?? sub.status}`);
      }
    }

    // 3) Best-effort: register the phone for Cloud API sending. Embedded Signup
    //    usually pre-registers it; a failure here (already registered / PIN set)
    //    must not block channel creation, so we log and continue.
    const reg = await metaGraphFetch(`/${phoneNumberId}/register`, {
      accessToken,
      bearer: true,
      method: 'POST',
      body: { messaging_product: 'whatsapp', pin: '000000' },
    });
    if (!reg.ok) {
      this.logger.log(`WA signup: phone ${phoneNumberId} register skipped: ${reg.error?.message ?? reg.status}`);
    }

    // 4) Create, or rotate the token of, the workspace's WHATSAPP channel.
    const secrets = { accessToken, phoneNumberId };
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'WHATSAPP', externalId: phoneNumberId },
    });
    if (existing) {
      return this.update(workspaceId, existing.id, { secrets, status: 'ACTIVE' });
    }
    return this.create(workspaceId, {
      type: 'WHATSAPP',
      name: `WhatsApp ${phoneNumberId}`,
      externalId: phoneNumberId,
      secrets,
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateChannelInput) {
    const existing = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Channel not found');
    await this.assertChannelFeature(workspaceId, existing.type);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.agentProfileId !== undefined) {
      // The panel picks from a workspace-scoped list, so this hole is invisible
      // there — but the endpoint takes a raw id, and an unvalidated one would
      // let a channel answer with ANOTHER tenant's agent: their persona, their
      // guardrails, their knowledge base, replying to this workspace's
      // customers. Scope the read, and the id becomes unusable across tenants.
      if (dto.agentProfileId) {
        const agent = await this.prisma.agentProfile.findFirst({
          where: { id: dto.agentProfileId, workspaceId },
          select: { id: true },
        });
        if (!agent) throw new NotFoundException('Agent profile not found');
      }
      data.agentProfileId = dto.agentProfileId;
    }
    let pendingAddress: string | null = null;
    let identityWritten = false;
    if (dto.externalId !== undefined) {
      const requested = this.normalizeExternalId(existing.type, dto.externalId);
      const claim = await this.resolveEmailClaim(
        workspaceId,
        existing.type,
        requested,
        dto.addressProof,
      );
      await this.assertExternalIdFree(existing.type, claim.externalId, existing.id);
      data.externalId = claim.externalId;
      pendingAddress = claim.pendingAddress;
      identityWritten = true;
    } else if (dto.status === 'ACTIVE' && existing.status !== 'ACTIVE' && existing.externalId) {
      // Re-activation is a registration too. The identity was NOT held while
      // this row sat DISABLED, so someone else may legitimately have taken it
      // in the meantime; coming back ACTIVE without re-checking is how two
      // ACTIVE rows end up sharing one provider identity. Reached in normal
      // use, not just by hand: completeWhatsappSignup re-connects an existing
      // number with `update(ws, id, { secrets, status: 'ACTIVE' })`.
      await this.assertExternalIdFree(existing.type, existing.externalId, existing.id);
    }
    /**
     * MERGE, never replace — and merged by the DATABASE, not here.
     *
     * `configPublic` is a settings object to a tenant, but it is also where
     * the machines keep their place: `imapLastUid`/`imapUidValidity`, the
     * poison-pill counters `imapFailUid`/`imapFailCount`, the Sent
     * reconciler's `imapSentLastUid`, and the `health` block the mailbox card
     * reads. A settings save that posts only the keys the dialog knows about
     * used to wipe every one of them — which resets the cursor, so the next
     * tick reads the mailbox as a FIRST RUN and holds the automation on a
     * week of live replies, and drops the backoff a dead credential earned.
     *
     * Merging onto `existing` in JS fixed the wipe but not the race: `existing`
     * was read at the top of this method, several awaits (and a credential
     * probe) ago, and every one of those machine writers can commit inside
     * that window. `mergeConfigPublic` hands Postgres the keys this save
     * actually owns and lets it apply them to the row as it stands.
     *
     * Merging costs the ability to DELETE a key from the client, which no
     * caller does; `pendingAddress` is removed explicitly through `drop`,
     * which is how a key that genuinely has to go is removed.
     */
    const publicPatch: Record<string, unknown> = { ...(dto.configPublic ?? {}) };
    const publicDrop: string[] = [];
    let writePublic = dto.configPublic !== undefined;
    // The parked address travels WITH the identity write, so the card never
    // shows a mailbox that is both claimed and still waiting to be proven.
    if (existing.type === 'EMAIL' && identityWritten) {
      writePublic = true;
      if (pendingAddress) publicPatch.pendingAddress = pendingAddress;
      else publicDrop.push('pendingAddress');
    }
    const secretsWritten = !!(
      (dto.secrets && Object.keys(dto.secrets).length) ||
      dto.clearSecretKeys?.length
    );
    if (secretsWritten) {
      // Merge onto existing secrets so a partial update (e.g. rotate one key)
      // doesn't wipe the rest.
      let current: Record<string, string> = {};
      if (existing.configSealed && isSecretBoxConfigured()) {
        try {
          current = JSON.parse(openSecret(existing.configSealed));
        } catch {
          /* unreadable box — replace wholesale */
        }
      }
      const merged = { ...current, ...(dto.secrets ?? {}) };
      // After the merge, so a key named in both is dropped rather than set —
      // a caller asking to clear something means it, whatever else it sent.
      for (const k of dto.clearSecretKeys ?? []) delete merged[k];
      // The MERGED result is what the transports will use, so it is what gets
      // validated — rotating one field must not be able to leave the row in a
      // state a fresh save would have refused.
      await this.assertSecrets(existing.type, merged);
      data.configSealed = this.seal(merged);
    }
    // A save that touches `configPublic` is two statements — the jsonb merge
    // and the rest of the row — so they ride one transaction and the `update`
    // reads the merged column back for the response. A save that does not (a
    // rename, a status flip, an agent binding) stays the single write it was.
    const c = writePublic
      ? await this.prisma.$transaction(async (tx) => {
          await mergeConfigPublic(tx, { id: existing.id, workspaceId }, publicPatch, publicDrop);
          return tx.channel.update({ where: { id: existing.id }, data });
        })
      : await this.prisma.channel.update({ where: { id: existing.id }, data });
    if (!secretsWritten) return this.mask(c);
    // Re-prove ONLY on a credential rewrite. This is what closes the "rotated
    // password keeps reading READY" hole that workspace-readiness documents,
    // without re-dialling a mail server every time somebody renames a channel.
    const proved = await this.proveMailbox(workspaceId, c, existing);
    return { ...this.mask(proved.row), health: proved.health };
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.channel.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Channel not found');
    return { message: 'Channel deleted' };
  }

  async verify(workspaceId: string, id: string) {
    const c = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Channel not found');
    await this.assertChannelFeature(workspaceId, c.type);
    // No timeout here, unlike a save: Verify is an explicit act by somebody who
    // is waiting for the answer, and the adapter bounds its own dials.
    const outcome = await this.runHealthCheck(c);
    if (outcome.ok) {
      await this.stampVerified(workspaceId, c, new Date());
    }
    return { ok: outcome.ok, ...(outcome.details !== undefined ? { details: outcome.details } : {}) };
  }

  /**
   * Run an adapter's health check and never let it become an exception.
   *
   * A throw here used to be a 500 with nothing in it. The panel is built to
   * read `details` — a rejected credential says one thing, an unreachable host
   * another — so a failure that cannot be described is the one outcome worth
   * avoiding. `reached: false` marks the answers we invented.
   */
  private async runHealthCheck(row: ChannelRowLike, timeoutMs?: number): Promise<HealthOutcome> {
    try {
      const adapter = this.registry.get(row.type);
      const call = adapter.healthCheck(this.registry.resolveConfig(row));
      const health = timeoutMs
        ? await withTimeout(call, timeoutMs, `${row.type} health check`)
        : await call;
      return { ok: !!health?.ok, details: health?.details, reached: true };
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 200);
      this.logger.warn(`channel ${row.id} health check failed: ${reason}`);
      return { ok: false, details: { reason }, reached: false };
    }
  }

  /**
   * Prove a mailbox the moment its credentials are written, and be the ONE
   * writer of `lastVerifiedAt`.
   *
   * That column is not decoration: `EmailImapPollService`, `EmailImapIdleService`
   * and `WorkspaceMailboxService.resolve` all select on it, so an unproven
   * mailbox is silently skipped — replies sit in it forever while the dialog
   * says "replies will flow" (`mailbox-not-auto-verified`). The invariant is
   * that `lastVerifiedAt` means A CHECK PASSED; it is satisfied by proving the
   * mailbox, never by loosening the filter.
   *
   * Three rules, each of them a defect avoided:
   *  - NON-FATAL. A failed or throwing check must still leave the row, or the
   *    save would discard the password and the IMAP overrides just typed — and
   *    `completeWhatsappSignup` needs the channel to exist before the WABA
   *    subscription propagates.
   *  - TIMEBOXED, so a wrong host cannot hold the request open.
   *  - The stamp is CLEARED only on a credential refusal. An unreachable probe
   *    is not evidence that a working mailbox is broken, and unplugging it
   *    would stop every reply until a human noticed.
   */
  private async proveMailbox(
    workspaceId: string,
    row: any,
    previous: { lastVerifiedAt?: Date | null } | null,
  ): Promise<{ row: any; health: { ok: boolean; details?: Record<string, unknown> } }> {
    const outcome = await this.runHealthCheck(row, CONNECT_CHECK_TIMEOUT_MS);
    let current = row;
    try {
      if (outcome.ok) {
        current = await this.stampVerified(workspaceId, row, new Date());
      } else if (previous?.lastVerifiedAt && this.isCredentialRefusal(outcome)) {
        current = await this.prisma.channel.update({
          where: { id: row.id },
          data: { lastVerifiedAt: null },
        });
      }
    } catch (e: any) {
      this.logger.warn(`channel ${row.id}: could not record the health check: ${e?.message ?? e}`);
    }
    return {
      row: current,
      health: { ok: outcome.ok, ...(outcome.details !== undefined ? { details: outcome.details } : {}) },
    };
  }

  /** The single `lastVerifiedAt` write, plus the one thing that goes with it:
   *  credentials the operator has just re-proven should let inbound try again
   *  now rather than serve out a backoff earned under the old password. */
  private async stampVerified(workspaceId: string, row: any, at: Date) {
    const updated = await this.prisma.channel.update({
      where: { id: row.id },
      data: { lastVerifiedAt: at },
    });
    if (row.type === 'EMAIL') {
      await this.mailboxHealth
        .clearBackoff({ id: row.id, workspaceId })
        .catch(() => undefined);
    }
    return updated;
  }

  /** Did the server ANSWER and refuse the credentials? Only that unplugs a
   *  mailbox — a timeout, a DNS failure or an unknown 5xx does not. */
  private isCredentialRefusal(outcome: HealthOutcome): boolean {
    if (!outcome.reached || outcome.ok) return false;
    const d = outcome.details ?? {};
    if (d.credsValid === false) return true;
    // `receiveReason` is deliberately NOT read: `ok` is SEND-truth, and an IMAP
    // failure must never unplug a mailbox that can still send.
    const reason = [d.reason, d.message, d.error].find((v) => typeof v === 'string' && v);
    return typeof reason === 'string' && classifySmtpError(reason).kind === 'systemic';
  }

  /** Per-type credential validation, in one place so create and update cannot
   *  drift — update validates the MERGED secrets, create the incoming ones. */
  private async assertSecrets(type: string, secrets: Record<string, string>): Promise<void> {
    if (type === 'SMS') assertNetgsmSmsSecrets(secrets);
    else if (type === 'TIKTOK') assertTiktokDmSecrets(secrets);
    else if (isMetaChannelType(type)) assertMetaSecrets(type, secrets);
    else if (type === 'LINKEDIN') assertLinkedinEngagementSecrets(secrets);
    else if (type === 'EMAIL') await assertEmailSecrets(secrets);
  }

  /**
   * Who may CLAIM an email address, and what happens to everyone else.
   *
   * `externalId` is self-asserted — `secrets` is optional, so nothing proved
   * the caller controls the address it registered — and it is globally unique
   * (`@@unique([type, externalId])`). A rival registering `info@rakip.com.tr`
   * therefore locked the real business out with a 409 forever
   * (`externalid-claim`). `healthCheck` cannot close this: it authenticates
   * against a host the same caller supplied, so it proves nothing about the
   * address.
   *
   * So an unproven address is PARKED rather than claimed: `externalId` stays
   * null (Postgres allows many NULLs under the unique index) and the intended
   * address sits in `configPublic.pendingAddress` until something proves it.
   * Nothing is lost by waiting — sending reads the sealed `fromEmail`, IMAP
   * selects on `lastVerifiedAt`, and the tokenized inbound URL routes by
   * channel id. The one reader that needs the claim is the legacy To-header
   * webhook, which is exactly the path that must stay proof-gated.
   */
  private async resolveEmailClaim(
    workspaceId: string,
    type: string,
    requested: string | null,
    proof?: EmailAddressProof,
  ): Promise<{ externalId: string | null; pendingAddress: string | null }> {
    if (type !== 'EMAIL' || !requested) return { externalId: requested, pendingAddress: null };
    if (proof === 'oauth') return { externalId: requested, pendingAddress: null };
    // The DNS proof this product already builds and verifies. Per-workspace and
    // evidence-based, so it cannot inherit the squat it is closing.
    const domain = domainOf(requested);
    const verified = domain
      ? await this.prisma.sendingDomain.findFirst({
          where: { workspaceId, domain, status: 'VERIFIED' },
          select: { id: true },
        })
      : null;
    return verified
      ? { externalId: requested, pendingAddress: null }
      : { externalId: null, pendingAddress: requested };
  }

  /** This workspace's channel that is already waiting on exactly this address. */
  private async findParkedEmailChannel(workspaceId: string, type: string, address: string) {
    if (type !== 'EMAIL') return null;
    const rows = await this.prisma.channel.findMany({
      where: { workspaceId, type: 'EMAIL', externalId: null },
      select: { id: true, configPublic: true },
    });
    const match = rows.find(
      (r) => (r.configPublic as { pendingAddress?: unknown } | null)?.pendingAddress === address,
    );
    return match ?? null;
  }

  /** The public config a channel starts life with. EMAIL gets G3's other half:
   *  a mailbox connected from NOW ON starts on the narrow inbound policy, while
   *  every channel connected before this keeps reading as `ALL_SENDERS` — a
   *  silent narrowing would make a live shared inbox look broken. */
  private initialConfigPublic(dto: CreateChannelInput, pendingAddress: string | null) {
    if (dto.type !== 'EMAIL') return dto.configPublic ?? undefined;
    const pub: Record<string, unknown> = { ...(dto.configPublic ?? {}) };
    if (pub.inboundPolicy === undefined) pub.inboundPolicy = NEW_CHANNEL_INBOUND_POLICY;
    if (pendingAddress) pub.pendingAddress = pendingAddress;
    return pub;
  }

  /**
   * İYS push-back registration (NetGSM Phase 2 Task 4) — SMS channel card
   * action. Mints this workspace's İYS webhook URL
   * (`netgsmWebhookUrl(base, workspaceId, 'iys')`) and asks NetGSM to
   * register it as the push-back target for consent changes, using this
   * SAME channel's sealed usercode/password + its `configPublic.brandCode`
   * (the same İYS creds resolution `IysSyncService.resolveCreds` uses).
   * Stamps `configPublic.iysWebhookRegistered` on SUCCESS only, so
   * `NetgsmOnboardingService`'s `iysWebhook` checklist row reflects reality
   * rather than "we tried" — a failed registration must be retried, and a
   * stale `true` would hide that from the operator.
   *
   * Gating note (NetGSM Phase 2 Task 6 — reconciling Task 4's placeholder):
   * this does NOT ride the generic `assertChannelFeature` (`sms`) gate that
   * every other SMS channel action here uses. Per the owner decision İYS is
   * bundled FREE with `campaigns`, not `sms` — the two are sold separately
   * (one plan block grants `sms` without `campaigns`: SMS channel/inbox
   * management with no campaign sending), and a workspace that can't launch
   * commercial campaigns (`MarketingCampaignsController` is entirely behind
   * `@RequiresFeature('campaigns')`) has nothing for İYS consent tracking to
   * protect. So this action checks `campaigns` explicitly instead — a
   * dedicated single-key check via `assertFeature`, not the type-keyed
   * `assertChannelFeature` used by create/update/verify.
   */
  async registerIysWebhook(workspaceId: string, id: string) {
    const c = await this.prisma.channel.findFirst({ where: { id, workspaceId, type: 'SMS' } });
    if (!c) throw new NotFoundException('SMS channel not found');
    await this.assertFeature(workspaceId, 'campaigns');

    const { secrets, public: pub } = this.registry.resolveConfig(c);
    const usercode = secrets?.usercode;
    const password = secrets?.password;
    const brandCode = typeof pub?.brandCode === 'string' ? pub.brandCode.trim() : '';
    if (!usercode || !password) {
      throw new BadRequestException('SMS channel has no NetGSM credentials configured yet');
    }
    if (!brandCode) {
      throw new BadRequestException('İYS marka kodu (brandCode) is not configured on this channel yet');
    }

    const url = netgsmWebhookUrl(process.env.PUBLIC_BASE_URL, workspaceId, 'iys');
    if (!url) {
      throw new ServiceUnavailableException('PUBLIC_BASE_URL / MARKETING_SECRET_KEY is not configured');
    }

    const result = await this.iysClient.registerWebhook({ usercode, password, brandCode }, url);
    if (!result.ok) {
      throw new BadRequestException(result.message ?? 'İYS webhook kaydı başarısız');
    }

    // One key, merged by the database: `configPublic` also carries the
    // machines' cursors and health block, and `c` was read before the İYS
    // round-trip.
    await mergeConfigPublic(this.prisma, { id: c.id, workspaceId: c.workspaceId }, { iysWebhookRegistered: true });

    return { ok: true, url };
  }

  private seal(secrets: Record<string, string>): string {
    if (!isSecretBoxConfigured()) {
      throw new ServiceUnavailableException(
        'MARKETING_SECRET_KEY is not configured — cannot store channel credentials',
      );
    }
    return sealSecret(JSON.stringify(secrets));
  }

  /** Public view: never the sealed blob — only which secret keys are present. */
  private mask(c: any) {
    let configuredSecrets: string[] = [];
    if (c.configSealed && isSecretBoxConfigured()) {
      try {
        configuredSecrets = Object.keys(JSON.parse(openSecret(c.configSealed)));
      } catch {
        configuredSecrets = ['(unreadable)'];
      }
    }
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      status: c.status,
      agentProfileId: c.agentProfileId,
      widgetKey: c.widgetKey,
      externalId: c.externalId,
      configPublic: c.configPublic ?? null,
      configuredSecrets,
      // SMS (NetGSM) inbound is unsigned, so we hand the operator a tokenized MO
      // callback URL to paste into the NetGSM panel ("İnteraktif SMS → URL'ye
      // yönlendir"). Null until PUBLIC_BASE_URL + MARKETING_SECRET_KEY are set.
      ...(c.type === 'SMS'
        ? { callbackUrl: netgsmMoCallbackUrl(process.env.PUBLIC_BASE_URL, c.id) }
        : {}),
      // Meta (WhatsApp/Messenger/IG) inbound + receipts arrive on ONE static,
      // signed webhook for the whole app. Surface the URL operators paste into
      // the Meta App dashboard (and whether the verify token env is set), the
      // way SMS surfaces its MO callback. Never expose the token value itself.
      ...(isMetaChannelType(c.type)
        ? {
            webhookUrl: metaWebhookCallbackUrl(process.env.PUBLIC_BASE_URL),
            verifyTokenConfigured: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
          }
        : {}),
      // TikTok DM (Business Messaging) inbound events arrive on a static, HMAC-
      // signed webhook. Surface the URL operators paste into the TikTok for
      // Business app dashboard, and the messaging-granted status from configPublic
      // (set by the OAuth confirm flow). Token value is never returned.
      ...(c.type === 'TIKTOK'
        ? {
            webhookUrl: tiktokWebhookCallbackUrl(process.env.PUBLIC_BASE_URL),
            messaging: (c.configPublic as Record<string, unknown> | null)?.messaging ?? null,
          }
        : {}),
      // EMAIL is two-way: outbound SMTP (sealed secrets) + inbound replies, by
      // IMAP or by a relay POSTing them to us.
      //
      // `inboundUrl` is the one a tenant can actually use: the channel id names
      // the workspace and the token makes the path unguessable, so it needs no
      // shared secret and a token holder cannot address anybody else's mailbox.
      // `webhookUrl` is the legacy platform-signed route, kept because a custom
      // relay may already sign it — `inboundSecretConfigured` says only whether
      // THAT route can work, and is not the readiness signal for inbound.
      // `pendingAddress` is an address this channel has asked for and not yet
      // proven (see `resolveEmailClaim`), so the card can name the mailbox it
      // means without implying the claim went through.
      ...(c.type === 'EMAIL'
        ? {
            inboundUrl: emailInboundCallbackUrl(process.env.PUBLIC_BASE_URL, c.id),
            webhookUrl: process.env.PUBLIC_BASE_URL
              ? `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/public/channels/email/webhook`
              : null,
            inboundSecretConfigured: !!process.env.EMAIL_INBOUND_SECRET,
            inboundAddress: c.externalId,
            pendingAddress:
              ((c.configPublic as { pendingAddress?: unknown } | null)?.pendingAddress as
                | string
                | undefined) ?? null,
          }
        : {}),
      lastVerifiedAt: c.lastVerifiedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
