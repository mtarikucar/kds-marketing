import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { BrandSourceResult } from './sources/brand-source';

export interface BrandAnalysisDraft {
  profile: {
    brandName?: string;
    tagline?: string;
    description?: string;
    valueProps?: string[];
    toneWords?: string[];
    voiceGuide?: string;
    icpDescription?: string;
    audienceObjections?: string[];
    offerings?: Array<{ name: string; blurb?: string; price?: string }>;
    socialHandles?: Array<{ network: string; handle: string }>;
  };
  researchProfile: {
    icpDescription?: string;
    businessTypes?: string[];
    geo?: { country?: string; regions?: string[]; cities?: string[] };
  };
  brandKitHints: { palette?: string[]; tone?: string; hashtags?: string[]; cta?: string };
  knowledgeDocs: Array<{ title: string; content: string }>;
}

// The tool Claude MUST call — its input is guaranteed valid JSON matching this
// schema, which is why we use tool-use instead of parsing free text.
const SUBMIT_BRAND_DRAFT_TOOL: Anthropic.Tool = {
  name: 'submit_brand_profile',
  description: 'Submit the synthesized brand profile, targeting, brand-kit hints, and knowledge docs.',
  input_schema: {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        properties: {
          brandName: { type: 'string' },
          tagline: { type: 'string' },
          description: { type: 'string' },
          valueProps: { type: 'array', items: { type: 'string' } },
          toneWords: { type: 'array', items: { type: 'string' } },
          voiceGuide: { type: 'string' },
          icpDescription: { type: 'string' },
          audienceObjections: { type: 'array', items: { type: 'string' } },
          offerings: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, blurb: { type: 'string' }, price: { type: 'string' } }, required: ['name'] } },
          socialHandles: { type: 'array', items: { type: 'object', properties: { network: { type: 'string' }, handle: { type: 'string' } }, required: ['network', 'handle'] } },
        },
      },
      researchProfile: {
        type: 'object',
        properties: {
          icpDescription: { type: 'string' },
          businessTypes: { type: 'array', items: { type: 'string' } },
          geo: { type: 'object', properties: { country: { type: 'string' }, regions: { type: 'array', items: { type: 'string' } }, cities: { type: 'array', items: { type: 'string' } } } },
        },
      },
      brandKitHints: {
        type: 'object',
        properties: { palette: { type: 'array', items: { type: 'string' } }, tone: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, cta: { type: 'string' } },
      },
      knowledgeDocs: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] } },
    },
    required: ['profile', 'researchProfile', 'brandKitHints', 'knowledgeDocs'],
  },
};

@Injectable()
export class BrandSynthesisService {
  private readonly logger = new Logger(BrandSynthesisService.name);
  constructor(
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
  ) {}

  async synthesize(workspaceId: string, sourceResults: BrandSourceResult[], defaultLanguage: string): Promise<BrandAnalysisDraft> {
    if (!this.anthropic.isEnabled()) throw new ServiceUnavailableException('AI is not configured');
    await this.credits.reserve(workspaceId, creditCost('brand.analyze'));
    try {
      return await this.callModel(sourceResults, defaultLanguage);
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('brand.analyze'));
      throw e;
    }
  }

  private async callModel(sourceResults: BrandSourceResult[], lang: string): Promise<BrandAnalysisDraft> {
    const digest = this.buildDigest(sourceResults);
    const system = [
      'You are a brand strategist. From the gathered source material about ONE business, synthesize a single structured brand profile.',
      `Write all synthesized text in language code "${lang}".`,
      'Infer value propositions, tone/voice, the ideal customer (ICP), likely objections, and concrete offerings from the material — do NOT invent facts not supported by the sources; leave a field empty rather than fabricate.',
      'For researchProfile, propose who this brand should PROSPECT for (their ideal *customers*): businessTypes + geo + an ICP description.',
      'For knowledgeDocs, select the most useful long-form passages (e.g. an about page, an FAQ, a product description) as {title, content} so they can be retrieved later.',
      'You MUST respond by calling the submit_brand_profile tool with your result. Do not reply with prose.',
    ].join('\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.anthropic.complete({
        system,
        messages: [{ role: 'user', content: attempt === 0 ? digest : `${digest}\n\nReminder: you MUST call submit_brand_profile.` }],
        tools: [SUBMIT_BRAND_DRAFT_TOOL],
        maxTokens: 4000,
        tier: tierFor('brand.analyze'),
      });
      const tu = res.toolUses.find((t) => t.name === 'submit_brand_profile');
      if (tu?.input) return this.normalize(tu.input as Record<string, any>);
      this.logger.warn(`brand synthesis attempt ${attempt + 1}: model did not call the tool`);
    }
    throw new Error('brand synthesis produced no structured draft');
  }

  /** Bound the material so the call stays within token limits; skip inert/error sources. */
  private buildDigest(sourceResults: BrandSourceResult[]): string {
    const parts: string[] = [];
    for (const r of sourceResults) {
      if (r.status !== 'ok' || !r.raw) continue;
      if (r.source === 'website' && Array.isArray(r.raw)) {
        for (const p of r.raw as Array<{ url: string; markdown: string }>) {
          parts.push(`# WEBSITE ${p.url}\n${(p.markdown ?? '').slice(0, 6000)}`);
        }
      } else if (r.source === 'gbp' && r.raw) {
        parts.push(`# GOOGLE BUSINESS\n${JSON.stringify(r.raw).slice(0, 6000)}`);
      } else if (r.source === 'social' && Array.isArray(r.raw)) {
        parts.push(`# SOCIAL\n${JSON.stringify(r.raw).slice(0, 4000)}`);
      } else if (r.source === 'uploads' && r.raw) {
        parts.push(`# UPLOADS\n${JSON.stringify(r.raw).slice(0, 6000)}`);
      }
    }
    return parts.join('\n\n').slice(0, 40_000) || 'No source material was gathered.';
  }

  /** Coerce the tool input into a well-formed draft (defensive defaults). */
  private normalize(input: Record<string, any>): BrandAnalysisDraft {
    const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
    const p = input.profile ?? {};
    const rp = input.researchProfile ?? {};
    const bk = input.brandKitHints ?? {};
    return {
      profile: {
        brandName: p.brandName, tagline: p.tagline, description: p.description,
        valueProps: arr(p.valueProps), toneWords: arr(p.toneWords), voiceGuide: p.voiceGuide,
        icpDescription: p.icpDescription, audienceObjections: arr(p.audienceObjections),
        offerings: arr(p.offerings), socialHandles: arr(p.socialHandles),
      },
      researchProfile: {
        icpDescription: rp.icpDescription, businessTypes: arr(rp.businessTypes),
        geo: rp.geo ?? undefined,
      },
      brandKitHints: { palette: arr(bk.palette), tone: bk.tone, hashtags: arr(bk.hashtags), cta: bk.cta },
      knowledgeDocs: arr(input.knowledgeDocs).filter((d) => d?.title && d?.content),
    };
  }
}
