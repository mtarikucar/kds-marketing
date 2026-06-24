import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isMetaAdsConfigured } from './ads.types';
import {
  listCampaigns,
  listAdSets,
  updateEntity,
  duplicateCampaign,
  createCampaign,
  MetaAdEntity,
  MetaWriteResult,
} from './meta-ads-management.client';

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

  constructor(private readonly prisma: PrismaService) {}

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
    let token: string;
    try {
      token = openSecret(account.accessToken);
    } catch {
      throw new BadRequestException('Access token could not be decrypted');
    }
    return { account, token };
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
    const { account, token } = await this.metaAccount(workspaceId, id);
    const r = await this.onResult(account.id, await updateEntity(token, entityId, { status }));
    if (!r.ok) throw new BadRequestException(r.error ?? 'Failed to update status');
    return { id: entityId, status };
  }

  /** Set a campaign/adset daily budget (major units → Meta minor units). */
  async setDailyBudget(workspaceId: string, id: string, entityId: string, dailyBudgetMajor: number) {
    if (!(dailyBudgetMajor > 0)) throw new BadRequestException('dailyBudget must be > 0');
    const { account, token } = await this.metaAccount(workspaceId, id);
    const cents = Math.round(dailyBudgetMajor * 100);
    const r = await this.onResult(account.id, await updateEntity(token, entityId, { daily_budget: cents }));
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
