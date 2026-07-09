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
import {
  createAdSet,
  uploadAdImage,
  uploadAdVideo,
  waitVideoReady,
  createAdCreative,
  createAd,
} from './meta-ads-management.client';
import { MediaGenService } from '../ai/media/media-gen.service';
import { safeFetch } from '../../../common/util/safe-fetch';

/** Launch a full Meta ad from a generated creative asset. */
export interface LaunchAdInput {
  generatedAssetId: string;
  campaignId?: string;
  campaignName?: string;
  objective?: string;
  adsetName: string;
  dailyBudget: number; // major units
  optimizationGoal: string;
  billingEvent: string;
  targeting: Record<string, any>;
  link: string;
  primaryText: string;
  callToAction: string;
  instagram?: boolean;
  status?: 'PAUSED' | 'ACTIVE';
}

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
    private readonly mediaGen: MediaGenService,
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

  /**
   * Launch a full Meta ad end-to-end from a generated creative asset:
   * campaign (or reuse) → ad set (targeting) → upload the creative (image bytes
   * or video pull-from-URL, so Meta COPIES the media and the R2 url isn't
   * load-bearing) → ad creative (object_story_spec) → ad node. Everything
   * defaults to PAUSED so a launch never immediately spends.
   */
  async launchAdFromCreative(workspaceId: string, id: string, dto: LaunchAdInput) {
    if (!(dto.dailyBudget > 0)) throw new BadRequestException('dailyBudget must be > 0');
    const { account, token } = await this.metaAccount(workspaceId, id);
    const pageId = await this.facebookPageId(workspaceId);
    const asset = await this.mediaGen.getAsset(workspaceId, dto.generatedAssetId);
    if (asset.status !== 'READY' || !asset.url) {
      throw new BadRequestException('The creative asset is not READY');
    }
    const status = dto.status ?? 'PAUSED';
    const run = async (p: Promise<MetaWriteResult>): Promise<MetaWriteResult> =>
      this.onResult(account.id, await p);

    // 1) Campaign — reuse or create.
    let campaignId = dto.campaignId;
    if (!campaignId) {
      const c = await run(createCampaign(token, account.externalAdId, { name: dto.campaignName ?? dto.adsetName, objective: dto.objective ?? 'OUTCOME_TRAFFIC' }));
      if (!c.ok || !c.id) throw new BadRequestException(c.error ?? 'Failed to create campaign');
      campaignId = c.id;
    }

    // 2) Ad set with targeting.
    const as = await run(createAdSet(token, account.externalAdId, {
      name: dto.adsetName,
      campaignId,
      optimizationGoal: dto.optimizationGoal,
      billingEvent: dto.billingEvent,
      dailyBudgetCents: Math.round(dto.dailyBudget * 100),
      targeting: dto.targeting,
      status,
    }));
    if (!as.ok || !as.id) throw new BadRequestException(as.error ?? 'Failed to create ad set');

    // 3) Creative — image (bytes → hash) or video (pull-from-URL → wait ready).
    const cta = { type: dto.callToAction, value: { link: dto.link } };
    let linkData: Record<string, any> | undefined;
    let videoData: Record<string, any> | undefined;
    const isVideo = asset.type === 'VIDEO' || (asset.mime ?? '').startsWith('video/');
    if (isVideo) {
      const up = await run(uploadAdVideo(token, account.externalAdId, asset.url, dto.adsetName));
      if (!up.ok || !up.id) throw new BadRequestException(up.error ?? 'Failed to upload video');
      const ready = await run(waitVideoReady(token, up.id));
      if (!ready.ok) throw new BadRequestException(ready.error ?? 'Video did not finish processing');
      videoData = { video_id: up.id, message: dto.primaryText, call_to_action: cta };
    } else {
      const bytes = await this.downloadBase64(asset.url);
      const img = await run(uploadAdImage(token, account.externalAdId, bytes));
      if (!img.ok || !img.id) throw new BadRequestException(img.error ?? 'Failed to upload image');
      linkData = { message: dto.primaryText, link: dto.link, image_hash: img.id, call_to_action: cta };
    }

    // 4) Ad creative + 5) ad node.
    const cr = await run(createAdCreative(token, account.externalAdId, {
      name: dto.adsetName,
      pageId,
      instagramActorId: dto.instagram ? await this.instagramActorId(workspaceId) : undefined,
      linkData,
      videoData,
    }));
    if (!cr.ok || !cr.id) throw new BadRequestException(cr.error ?? 'Failed to create ad creative');

    const ad = await run(createAd(token, account.externalAdId, { name: dto.adsetName, adsetId: as.id, creativeId: cr.id, status }));
    if (!ad.ok || !ad.id) throw new BadRequestException(ad.error ?? 'Failed to create ad');

    return { campaignId, adsetId: as.id, creativeId: cr.id, adId: ad.id, status };
  }

  /** The connected Facebook Page id (object_story_spec.page_id). */
  private async facebookPageId(workspaceId: string): Promise<string> {
    const acc = await this.prisma.socialAccount.findFirst({ where: { workspaceId, network: 'FACEBOOK', enabled: true }, select: { externalId: true } });
    if (!acc) throw new BadRequestException('Connect a Facebook Page before launching an ad');
    return acc.externalId;
  }

  private async instagramActorId(workspaceId: string): Promise<string | undefined> {
    const acc = await this.prisma.socialAccount.findFirst({ where: { workspaceId, network: 'INSTAGRAM', enabled: true }, select: { externalId: true } });
    return acc?.externalId;
  }

  /** SSRF-safe download of a media URL → base64 (Meta copies the bytes). */
  private async downloadBase64(url: string): Promise<string> {
    const res = await safeFetch(url, { method: 'GET', timeoutMs: 20_000 } as any);
    if (!res.ok) throw new BadRequestException('Failed to fetch the creative asset');
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  }
}

/** Meta minor units (cents) → major units, or null/undefined passthrough. */
function centsToMajor(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v / 100;
}
