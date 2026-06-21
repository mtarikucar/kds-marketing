import {
  Injectable,
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
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { PublicChannelResolverService } from './public-channel-resolver.service';
import { assertNetgsmSmsSecrets } from './netgsm-config.util';
import { netgsmMoCallbackUrl } from './netgsm-callback.util';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly resolver: PublicChannelResolverService,
  ) {}

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
      data.configSealed = this.seal(dto.secrets);
    }
    const c = await this.prisma.channel.create({ data: { ...data, workspaceId } });
    return this.mask(c);
  }

  async update(workspaceId: string, id: string, dto: UpdateChannelInput) {
    const existing = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Channel not found');
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
      lastVerifiedAt: c.lastVerifiedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
