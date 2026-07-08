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
import { EntitlementsService, FeatureKey } from '../../billing/entitlements.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { PublicChannelResolverService } from './public-channel-resolver.service';
import { assertNetgsmSmsSecrets } from './netgsm-config.util';
import { assertTiktokDmSecrets } from './tiktok-config.util';
import { netgsmMoCallbackUrl } from './netgsm-callback.util';
import { assertMetaSecrets, isMetaChannelType } from './meta-config.util';
import { metaWebhookCallbackUrl } from './meta-callback.util';
import { assertLinkedinEngagementSecrets } from './linkedin-config.util';
import { tiktokWebhookCallbackUrl } from './tiktok-callback.util';

export interface CreateChannelInput {
  type: string;
  name: string;
  agentProfileId?: string | null;
  externalId?: string | null;
  secrets?: Record<string, string>;
  configPublic?: Record<string, unknown>;
}
export interface UpdateChannelInput {
  name?: string;
  status?: string;
  agentProfileId?: string | null;
  externalId?: string | null;
  secrets?: Record<string, string>;
  configPublic?: Record<string, unknown>;
}

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
  ) {}

  /**
   * Per-type feature gate for channel save/verify. Channel CRUD is one generic
   * surface across every type, so the controller can't statically decide the
   * key — SMS requires `sms` (split off `conversationAi` for the NetGSM SMS v2
   * program); every other type keeps requiring `conversationAi`, unchanged.
   */
  private async assertChannelFeature(workspaceId: string, type: string): Promise<void> {
    const feature: FeatureKey = type === 'SMS' ? 'sms' : 'conversationAi';
    const effective = await this.entitlements.getEffective(workspaceId);
    if (!effective.features[feature]) {
      throw new ForbiddenException({
        message: 'This feature requires a higher package',
        feature,
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

  /** Reject registering a provider identity (type, externalId) another ACTIVE
   *  channel already owns — even in another workspace. byExternalId is the
   *  single sanctioned cross-workspace read; without this two tenants could
   *  claim the same inbound address and the webhook would deliver to whichever
   *  findFirst returns (cross-tenant mail). */
  private async assertExternalIdFree(type: string, externalId: string | null, excludeId?: string) {
    if (!externalId) return;
    const existing = await this.resolver.byExternalId(type, externalId);
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
    const externalId = this.normalizeExternalId(dto.type, dto.externalId);
    await this.assertExternalIdFree(dto.type, externalId);
    const data: any = {
      workspaceId,
      type: dto.type,
      name: dto.name,
      status: 'ACTIVE',
      agentProfileId: dto.agentProfileId ?? null,
      externalId,
      configPublic: dto.configPublic ?? undefined,
    };
    if (dto.type === 'WEBCHAT') {
      data.widgetKey = `wc_${randomBytes(16).toString('hex')}`;
    }
    if (dto.secrets && Object.keys(dto.secrets).length) {
      if (dto.type === 'SMS') assertNetgsmSmsSecrets(dto.secrets);
      else if (dto.type === 'TIKTOK') assertTiktokDmSecrets(dto.secrets);
      else if (isMetaChannelType(dto.type)) assertMetaSecrets(dto.type, dto.secrets);
      else if (dto.type === 'LINKEDIN') assertLinkedinEngagementSecrets(dto.secrets);
      data.configSealed = this.seal(dto.secrets);
    }
    const c = await this.prisma.channel.create({ data: { ...data, workspaceId } });
    return this.mask(c);
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
    if (dto.agentProfileId !== undefined) data.agentProfileId = dto.agentProfileId;
    if (dto.externalId !== undefined) {
      const externalId = this.normalizeExternalId(existing.type, dto.externalId);
      await this.assertExternalIdFree(existing.type, externalId, existing.id);
      data.externalId = externalId;
    }
    if (dto.configPublic !== undefined) data.configPublic = dto.configPublic;
    if (dto.secrets && Object.keys(dto.secrets).length) {
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
      const merged = { ...current, ...dto.secrets };
      if (existing.type === 'SMS') assertNetgsmSmsSecrets(merged);
      else if (existing.type === 'TIKTOK') assertTiktokDmSecrets(merged);
      else if (isMetaChannelType(existing.type)) assertMetaSecrets(existing.type, merged);
      else if (existing.type === 'LINKEDIN') assertLinkedinEngagementSecrets(merged);
      data.configSealed = this.seal(merged);
    }
    const c = await this.prisma.channel.update({ where: { id: existing.id }, data });
    return this.mask(c);
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
    const adapter = this.registry.get(c.type);
    const health = await adapter.healthCheck(this.registry.resolveConfig(c));
    if (health.ok) {
      await this.prisma.channel.update({
        where: { id: c.id },
        data: { lastVerifiedAt: new Date() },
      });
    }
    return health;
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
      // EMAIL is two-way: outbound SMTP (sealed secrets) + inbound replies parsed
      // by the workspace's email provider POSTing to our signed inbound webhook.
      // Surface the webhook URL to paste into the ESP, whether the platform-global
      // signing key is set (inbound is 401-dead without it), and the inbound
      // address the channel resolves by — so the UI can show BOTH halves' status.
      ...(c.type === 'EMAIL'
        ? {
            webhookUrl: process.env.PUBLIC_BASE_URL
              ? `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/public/channels/email/webhook`
              : null,
            inboundSecretConfigured: !!process.env.EMAIL_INBOUND_SECRET,
            inboundAddress: c.externalId,
          }
        : {}),
      lastVerifiedAt: c.lastVerifiedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
