import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isMetaAdsConfigured, isTiktokAdsConfigured, isLinkedinAdsConfigured } from './ads.types';
import { AdWriteCapabilityService } from './ad-write-capability.service';
import {
  listCampaigns,
  listAdSets,
  updateEntity,
  duplicateCampaign,
  createCampaign,
  MetaAdEntity,
  MetaWriteResult,
} from './meta-ads-management.client';
import { setTiktokCampaignBudget, setTiktokCampaignStatus } from './tiktok-ads.client';
import { updateLinkedinCampaign } from './linkedin-ads.client';

export type AdStatus = 'ACTIVE' | 'PAUSED';

/** Public-facing entity (budgets in major units for the UI). */
export interface AdEntityView {
  id: string;
  name: string;
  status: string;
  effectiveStatus?: string;
  objective?: string;
  campaignId?: string;
  dailyBudget?: number | null; // major units
  lifetimeBudget?: number | null; // major units
}

/**
 * Meta ad MANAGEMENT (write): list campaigns/adsets, change budget, pause/resume,
 * duplicate, create. Meta-only — TikTok management is a separate API and stays
 * read-only here. Needs a connected account whose token carries `ads_management`.
 */
@Injectable()
export class AdManagementService {
  private readonly logger = new Logger(AdManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: AdWriteCapabilityService,
  ) {}

  /** Load a workspace-owned META ad account and decrypt its token. */
  private async metaAccount(workspaceId: string, id: string) {
    const account = await this.prisma.adAccount.findFirst({ where: { id, workspaceId } });
    if (!account) throw new NotFoundException('Ad account not found');
    if (account.provider !== 'META') {
      throw new BadRequestException('Ad management is only supported for Meta accounts');
    }
    if (!isMetaAdsConfigured()) {
      throw new BadRequestException('Meta ads is not configured on this platform');
    }
    return { account, token: this.decrypt(account.accessToken) };
  }

  /** Load any WRITE-capable ad account (META | TIKTOK | LINKEDIN) + its token. */
  private async writableAccount(workspaceId: string, id: string) {
    const account = await this.prisma.adAccount.findFirst({ where: { id, workspaceId } });
    if (!account) throw new NotFoundException('Ad account not found');
    const configured =
      (account.provider === 'META' && isMetaAdsConfigured()) ||
      (account.provider === 'TIKTOK' && isTiktokAdsConfigured()) ||
      (account.provider === 'LINKEDIN' && isLinkedinAdsConfigured());
    if (!configured) {
      throw new BadRequestException(`${account.provider} ads is not configured on this platform`);
    }
    return { account, token: this.decrypt(account.accessToken) };
  }

  private decrypt(sealed: string): string {
    try {
      return openSecret(sealed);
    } catch {
      throw new BadRequestException('Access token could not be decrypted');
    }
  }

  /** Flip the account to needs-reauth when a management call hits a token error. */
  private async onResult<T extends { isAuthError?: boolean; ok: boolean; error?: string }>(
    accountId: string,
    r: T,
  ): Promise<T> {
    if (!r.ok && r.isAuthError) {
      await this.prisma.adAccount
        .update({ where: { id: accountId }, data: { status: 'TOKEN_EXPIRED', lastError: 'reauth_required' } })
        .catch(() => undefined);
    }
    return r;
  }

  private toView(e: MetaAdEntity): AdEntityView {
    return {
      id: e.id,
      name: e.name,
      status: e.status,
      effectiveStatus: e.effectiveStatus,
      objective: e.objective,
      campaignId: e.campaignId,
      dailyBudget: centsToMajor(e.dailyBudget),
      lifetimeBudget: centsToMajor(e.lifetimeBudget),
    };
  }

  async campaigns(workspaceId: string, id: string): Promise<AdEntityView[]> {
    const { account, token } = await this.metaAccount(workspaceId, id);
    const r = await this.onResult(account.id, await listCampaigns(token, account.externalAdId));
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to list campaigns');
    return r.items.map((e) => this.toView(e));
  }

  async adsets(workspaceId: string, id: string, campaignId?: string): Promise<AdEntityView[]> {
    const { account, token } = await this.metaAccount(workspaceId, id);
    const r = await this.onResult(account.id, await listAdSets(token, account.externalAdId, campaignId));
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to list ad sets');
    return r.items.map((e) => this.toView(e));
  }

  async setStatus(workspaceId: string, id: string, entityId: string, status: AdStatus) {
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      throw new BadRequestException('status must be ACTIVE or PAUSED');
    }
    const { account, token } = await this.writableAccount(workspaceId, id);
    if (!this.capabilities.canPauseResume(account.provider)) {
      throw new BadRequestException(`Pause/resume is not available for ${account.provider}`);
    }
    const write =
      account.provider === 'TIKTOK'
        ? setTiktokCampaignStatus(token, account.externalAdId, entityId, status)
        : account.provider === 'LINKEDIN'
          ? updateLinkedinCampaign(token, entityId, { status })
          : updateEntity(token, entityId, { status });
    const r = await this.onResult(account.id, await write);
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to update status');
    return { id: entityId, status };
  }

  /** Set a campaign daily budget. Meta wants minor units (cents); TikTok/LinkedIn
   *  take the account-currency MAJOR amount directly (a ×100 there is a 100× overspend). */
  async setDailyBudget(workspaceId: string, id: string, entityId: string, dailyBudgetMajor: number) {
    if (!(dailyBudgetMajor > 0)) throw new BadRequestException('dailyBudget must be > 0');
    const { account, token } = await this.writableAccount(workspaceId, id);
    if (!this.capabilities.canWriteBudget(account.provider)) {
      throw new BadRequestException(`Budget writes are not available for ${account.provider}`);
    }
    let write: Promise<MetaWriteResult>;
    if (account.provider === 'TIKTOK') {
      write = setTiktokCampaignBudget(token, account.externalAdId, entityId, dailyBudgetMajor);
    } else if (account.provider === 'LINKEDIN') {
      if (!account.currency) {
        throw new BadRequestException('LinkedIn budget needs the ad account currency; reconnect the account');
      }
      write = updateLinkedinCampaign(token, entityId, { dailyBudgetMajor, currencyCode: account.currency });
    } else {
      write = updateEntity(token, entityId, { daily_budget: Math.round(dailyBudgetMajor * 100) });
    }
    const r = await this.onResult(account.id, await write);
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to update budget');
    return { id: entityId, dailyBudget: dailyBudgetMajor };
  }

  async duplicate(workspaceId: string, id: string, campaignId: string): Promise<MetaWriteResult> {
    const { account, token } = await this.metaAccount(workspaceId, id);
    const r = await this.onResult(account.id, await duplicateCampaign(token, campaignId));
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to duplicate campaign');
    return r;
  }

  async create(workspaceId: string, id: string, input: { name: string; objective: string }) {
    const { account, token } = await this.metaAccount(workspaceId, id);
    const r = await this.onResult(account.id, await createCampaign(token, account.externalAdId, input));
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to create campaign');
    return r;
  }
}

/** Meta minor units (cents) → major units, or null/undefined passthrough. */
function centsToMajor(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v / 100;
}
