import { Injectable } from '@nestjs/common';
import {
  isMetaAdsConfigured,
  isTiktokAdsConfigured,
  isLinkedinAdsConfigured,
  isGoogleAdsConfigured,
} from './ads.types';

export interface AdWriteCapabilities {
  provider: string;
  setBudget: boolean;
  pauseResume: boolean;
  createCampaign: boolean;
  duplicate: boolean;
  /** Push a CRM segment up as a Custom/Lookalike audience. */
  syncAudience: boolean;
  /** Env-gated: creds present so a live write can actually happen. */
  configured: boolean;
  note: string;
}

/**
 * The ad-platform WRITE capability seam (Faz 6/7). Encodes, as first-class data,
 * which providers Jeeta can actually write budgets to today — so the Budget
 * Autopilot executor asks this BEFORE attempting a live change instead of a
 * hardcoded Meta-only check scattered in services. Reflects the audited reality:
 * Meta = full write (gated on creds); TikTok/LinkedIn = read-only (write clients
 * pending); Google = absent. New write providers register here as they ship,
 * with no change to callers.
 */
@Injectable()
export class AdWriteCapabilityService {
  private readonly matrix: Record<string, Omit<AdWriteCapabilities, 'configured'>> = {
    META: {
      provider: 'META',
      setBudget: true,
      pauseResume: true,
      createCampaign: true,
      duplicate: true,
      syncAudience: true,
      note: 'Full Marketing API write (needs an ads_management-scoped token).',
    },
    TIKTOK: {
      provider: 'TIKTOK',
      setBudget: true,
      pauseResume: true,
      createCampaign: false,
      duplicate: false,
      syncAudience: true,
      note: 'Campaign budget + pause/resume + DMP audience upload; gated on TikTok Business creds.',
    },
    LINKEDIN: {
      provider: 'LINKEDIN',
      setBudget: true,
      pauseResume: true,
      createCampaign: false,
      duplicate: false,
      syncAudience: true,
      note: 'Campaign budget + pause/resume + DMP segment upload; needs rw_ads/rw_dmp_segments scope.',
    },
    GOOGLE: {
      provider: 'GOOGLE',
      setBudget: true,
      pauseResume: true,
      createCampaign: false,
      duplicate: false,
      syncAudience: false,
      note: 'Budget + pause/resume via the Google Ads API (needs a developer token + connected account).',
    },
  };

  get(provider: string): AdWriteCapabilities {
    const base = this.matrix[provider] ?? {
      provider,
      setBudget: false,
      pauseResume: false,
      createCampaign: false,
      duplicate: false,
      syncAudience: false,
      note: 'Unknown provider.',
    };
    return { ...base, configured: this.configured(provider) };
  }

  /** True when the autopilot can push a live budget change to this provider now. */
  canWriteBudget(provider: string): boolean {
    const cap = this.get(provider);
    return cap.setBudget && cap.configured;
  }

  /** True when we can pause/resume an entity on this provider now. */
  canPauseResume(provider: string): boolean {
    const cap = this.get(provider);
    return cap.pauseResume && cap.configured;
  }

  /** True when a CRM segment can be synced to this provider as an audience now. */
  canSyncAudience(provider: string): boolean {
    const cap = this.get(provider);
    return cap.syncAudience && cap.configured;
  }

  all(): AdWriteCapabilities[] {
    return Object.keys(this.matrix).map((p) => this.get(p));
  }

  private configured(provider: string): boolean {
    switch (provider) {
      case 'META':
        return isMetaAdsConfigured();
      case 'TIKTOK':
        return isTiktokAdsConfigured();
      case 'LINKEDIN':
        return isLinkedinAdsConfigured();
      case 'GOOGLE':
        return isGoogleAdsConfigured();
      default:
        return false; // no live write path wired yet
    }
  }
}
