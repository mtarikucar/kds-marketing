import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface SaveTemplateInput {
  sourcePlatform: 'TIKTOK' | 'INSTAGRAM' | 'YOUTUBE';
  sourceUrl?: string;
  title?: string;
  hookPattern?: string;
  sceneStructure?: Array<{ scene: string; note?: string }>;
  pacingNote?: string;
  captionPattern?: string;
  riskScore?: number;
  extractedByAi?: boolean;
}

export interface BrandContext {
  name: string;
  product?: string;
  audience?: string;
  tone?: string;
  valueProps?: string[];
}

export interface RemixBrief {
  sourcePlatform: string;
  hook: string;
  scenes: Array<{ scene: string; direction: string }>;
  pacingNote?: string;
  captionDraft: string;
  complianceNote: string;
}

const RISK_THRESHOLD = 60;

/**
 * Trend → Remix as FORMAT INTELLIGENCE (Faz 4). We never copy a source video —
 * we store its abstract structure and adapt that structure onto the customer's
 * brand. `buildRemixBrief` is pure (no I/O): it turns an abstract TrendTemplate
 * + a brand context into a brand-specific creative brief, and always surfaces a
 * compliance note (elevated when the template's ToS/copy risk is high). Trend
 * extraction (Apify/official APIs) is the env-gated ingestion follow-up.
 */
@Injectable()
export class TrendRemixService {
  constructor(private readonly prisma: PrismaService) {}

  saveTemplate(workspaceId: string, input: SaveTemplateInput) {
    return this.prisma.trendTemplate.create({
      data: {
        workspaceId,
        sourcePlatform: input.sourcePlatform,
        sourceUrl: input.sourceUrl,
        title: input.title,
        hookPattern: input.hookPattern,
        sceneStructure: (input.sceneStructure ?? undefined) as Prisma.InputJsonValue | undefined,
        pacingNote: input.pacingNote,
        captionPattern: input.captionPattern,
        riskScore: clampInt(input.riskScore ?? 0, 0, 100),
        extractedByAi: input.extractedByAi ?? false,
      },
    });
  }

  list(workspaceId: string) {
    return this.prisma.trendTemplate.findMany({
      where: { workspaceId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Pure: adapt an abstract trend format onto a brand. Returns a brief the video
   * pipeline can act on — never the source's literal words/scenes.
   */
  buildRemixBrief(template: TemplateLike, brand: BrandContext): RemixBrief {
    const subject = brand.product ?? brand.name;
    const audience = brand.audience ? ` for ${brand.audience}` : '';
    const tone = brand.tone ?? 'authentic';

    const hook = template.hookPattern
      ? `${adaptPattern(template.hookPattern, subject)}${audience}`
      : `A ${tone} hook about ${subject}${audience}`;

    const rawScenes = Array.isArray(template.sceneStructure) ? (template.sceneStructure as Array<{ scene?: string; note?: string }>) : [];
    const scenes = (rawScenes.length ? rawScenes : DEFAULT_SCENES).map((s, i) => ({
      scene: s.scene ?? DEFAULT_SCENES[i % DEFAULT_SCENES.length].scene,
      direction: `${s.note ? s.note + ' — ' : ''}reshoot with ${brand.name}'s ${subject} in a ${tone} style`,
    }));

    const props = brand.valueProps?.length ? ` Highlight: ${brand.valueProps.slice(0, 3).join(', ')}.` : '';
    const captionDraft = template.captionPattern
      ? `${adaptPattern(template.captionPattern, subject)}${props}`
      : `${subject} — ${tone} take.${props}`;

    const highRisk = (template.riskScore ?? 0) >= RISK_THRESHOLD;
    const complianceNote = highRisk
      ? 'HIGH copy/ToS risk: use only the abstract structure (hook/pacing), never the source audio, footage, or exact wording. Legal review recommended for regulated verticals.'
      : 'Use the abstract format only; original brand footage/audio required. Add AI-content disclosure per platform policy.';

    return {
      sourcePlatform: template.sourcePlatform,
      hook,
      scenes,
      pacingNote: template.pacingNote ?? undefined,
      captionDraft,
      complianceNote,
    };
  }
}

interface TemplateLike {
  sourcePlatform: string;
  hookPattern?: string | null;
  sceneStructure?: unknown;
  pacingNote?: string | null;
  captionPattern?: string | null;
  riskScore?: number | null;
}

const DEFAULT_SCENES = [
  { scene: 'Hook (0-3s)' },
  { scene: 'Problem / demo (3-8s)' },
  { scene: 'Social proof (8-12s)' },
  { scene: 'CTA (12-15s)' },
];

/** Replace a generic placeholder in an abstract pattern with the brand subject. */
function adaptPattern(pattern: string, subject: string): string {
  return pattern.replace(/\[(product|subject|x)\]/gi, subject);
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
