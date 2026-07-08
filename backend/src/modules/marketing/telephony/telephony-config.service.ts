import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { assertNetsantralConfig } from './telephony-config.util';
import { BalanceClient } from '../../netgsm/balance/balance.client';

export interface UpsertTelephonyInput {
  secrets?: Record<string, string>;
  trunk?: string;
  pbxnum?: string;
  status?: string;
  wssUrl?: string;
  sipDomain?: string;
}
export interface ResolvedNetsantral {
  username: string;
  password: string;
  trunk: string;
  pbxnum?: string;
}

@Injectable()
export class TelephonyConfigService {
  private readonly logger = new Logger(TelephonyConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceClient: BalanceClient,
  ) {}

  async get(workspaceId: string) {
    const c = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    return c ? this.mask(c) : null;
  }

  async upsert(workspaceId: string, dto: UpsertTelephonyInput) {
    const existing = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    let merged: Record<string, string> = {};
    if (existing?.configSealed && isSecretBoxConfigured()) {
      try { merged = JSON.parse(openSecret(existing.configSealed)); } catch { /* replace */ }
    }
    if (dto.secrets && Object.keys(dto.secrets).length) merged = { ...merged, ...dto.secrets };
    const trunk = dto.trunk ?? existing?.trunk ?? undefined;
    // Validate the MERGED result (a partial update must still leave a complete,
    // sealable config) — actionable save-time error beats a silent later failure.
    assertNetsantralConfig(merged, { trunk });
    if (!isSecretBoxConfigured()) {
      throw new ServiceUnavailableException('MARKETING_SECRET_KEY is not configured — cannot store telephony credentials');
    }
    const data = {
      provider: 'netgsm-netsantral',
      status: dto.status ?? existing?.status ?? 'ACTIVE',
      configSealed: sealSecret(JSON.stringify(merged)),
      trunk: trunk ?? null,
      pbxnum: dto.pbxnum ?? existing?.pbxnum ?? null,
      wssUrl: dto.wssUrl ?? existing?.wssUrl ?? null,
      sipDomain: dto.sipDomain ?? existing?.sipDomain ?? null,
    };
    const c = await this.prisma.telephonyConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return this.mask(c);
  }

  /** Decrypted creds for an ACTIVE config, or null. Used by SalesCallService. */
  async resolveForWorkspace(workspaceId: string): Promise<ResolvedNetsantral | null> {
    const c = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    if (!c || c.status !== 'ACTIVE' || !c.configSealed || !c.trunk) return null;
    if (!isSecretBoxConfigured()) {
      this.logger.warn(
        'TelephonyConfig present but MARKETING_SECRET_KEY missing — api-dial disabled for workspace ' + workspaceId,
      );
      return null;
    }
    let creds: Record<string, string>;
    try { creds = JSON.parse(openSecret(c.configSealed)); } catch { return null; }
    if (!creds.username || !creds.password) return null;
    return { username: creds.username, password: creds.password, trunk: c.trunk, pbxnum: c.pbxnum ?? undefined };
  }

  /** Live verify of the santral creds via /balance (works off-prod, unlike CDR). */
  async verifyCreds(workspaceId: string) {
    const cfg = await this.resolveForWorkspace(workspaceId);
    if (!cfg) return { configured: false as const, balance: null };
    const balance = await this.balanceClient.fetchBalance({ usercode: cfg.username, password: cfg.password });
    return { configured: true as const, balance };
  }

  /** Set a rep's Netsantral extension + own phone (workspace-scoped). */
  async setDahili(
    workspaceId: string,
    marketingUserId: string,
    dahili: string | null | undefined,
    sipPassword?: string,
    phone?: string | null,
  ) {
    const data: { dahili?: string | null; dahiliSecret?: string | null; phone?: string | null } = {};
    // Only touch dahili when explicitly provided (undefined = leave as-is) — so a
    // caller editing just the phone/SIP password can't null out a saved extension.
    if (dahili !== undefined) data.dahili = dahili?.trim() || null;
    if (sipPassword !== undefined) {
      if (sipPassword && !isSecretBoxConfigured()) {
        throw new ServiceUnavailableException('MARKETING_SECRET_KEY is not configured — cannot store the SIP password');
      }
      data.dahiliSecret = sipPassword ? sealSecret(sipPassword) : null;
    }
    // Only touch phone when explicitly provided (undefined = leave as-is).
    if (phone !== undefined) data.phone = phone?.trim() || null;
    const res = await this.prisma.marketingUser.updateMany({ where: { id: marketingUserId, workspaceId }, data });
    if (res.count === 0) throw new NotFoundException('User not found');
    return { ok: true };
  }

  /** Webphone config for the AUTHENTICATED rep's own dahili, or null. */
  async webphoneConfigFor(workspaceId: string, marketingUserId: string) {
    const c = await this.prisma.telephonyConfig.findUnique({ where: { workspaceId } });
    if (!c || c.status !== 'ACTIVE' || !c.wssUrl || !c.sipDomain || !isSecretBoxConfigured()) return null;
    const rep = await this.prisma.marketingUser.findFirst({
      where: { id: marketingUserId, workspaceId },
      select: { dahili: true, dahiliSecret: true, firstName: true, lastName: true },
    });
    if (!rep?.dahili || !rep?.dahiliSecret) return null;
    let sipPassword: string;
    try { sipPassword = openSecret(rep.dahiliSecret); } catch { return null; }
    // NetGSM Netsantral's SIP auth username is the FULL "<ext>-<santral>" (e.g.
    // "101-8508407303"), NOT the bare extension — registering with just "101"
    // 401s (extension stays unregistered → calls can't ring it). The bare
    // extension is still what originate uses for internal_num; only the webphone
    // register needs the full form, so derive it here from dahili + trunk.
    const sipUsername =
      rep.dahili.includes('-') || !c.trunk ? rep.dahili : `${rep.dahili}-${c.trunk}`;
    return { wssUrl: c.wssUrl, sipDomain: c.sipDomain, dahili: sipUsername, sipPassword, displayName: `${rep.firstName} ${rep.lastName}`.trim() };
  }

  private mask(c: any) {
    let configuredSecrets: string[] = [];
    if (c.configSealed && isSecretBoxConfigured()) {
      try { configuredSecrets = Object.keys(JSON.parse(openSecret(c.configSealed))); } catch { configuredSecrets = ['(unreadable)']; }
    }
    return {
      id: c.id, workspaceId: c.workspaceId, provider: c.provider, status: c.status,
      trunk: c.trunk, pbxnum: c.pbxnum, configuredSecrets,
      wssUrl: c.wssUrl, sipDomain: c.sipDomain,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }
}
