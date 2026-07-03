import { Injectable } from '@nestjs/common';

export type VideoModel = 'seedance' | 'veo' | 'kling' | 'higgsfield';

export interface VideoBrief {
  product: string;
  hook?: string;
  offer?: string;
  durationSec?: 15 | 30 | 45;
  tone?: string;
  audience?: string;
}

export interface PersonaLock {
  name: string;
  referenceImageUrls: string[];
  lockedSeed?: number | null;
}

export interface Shot {
  ord: number;
  scene: string;
  voiceover: string;
  prompt: string;
  durationSec: number;
  cameraNote: string;
  reference?: { images: string[]; seed?: number };
}

export interface ShotPlan {
  model: VideoModel;
  durationSec: number;
  shots: Shot[];
  captionSuggestion: string;
  qcChecklist: string[];
}

interface SceneSpec {
  scene: string;
  camera: string;
  vo: (b: VideoBrief) => string;
  desc: (b: VideoBrief) => string;
}

/**
 * AI video / UGC shot planner (Faz 2). PURE: a brief + brand + optional persona
 * → a structured, per-shot generation plan. The persona's reference images +
 * locked seed are threaded into EVERY shot so the same face/outfit/identity
 * holds across the whole ad (the Seedance @reference / Higgsfield Soul ID
 * pattern). Per-model prompt formatting is here; the actual generation call
 * (fal/Higgsfield) is the env-gated executor that consumes this plan.
 */
@Injectable()
export class VideoPipelineService {
  planShots(brief: VideoBrief, model: VideoModel = 'seedance', persona?: PersonaLock): ShotPlan {
    const durationSec = brief.durationSec ?? 15;
    const specs = SCENES;
    const per = Math.max(2, Math.round(durationSec / specs.length));

    const shots: Shot[] = specs.map((s, i) => {
      const prompt = this.buildModelPrompt(model, s.desc(brief), persona);
      const shot: Shot = {
        ord: i,
        scene: s.scene,
        voiceover: s.vo(brief),
        prompt,
        durationSec: per,
        cameraNote: s.camera,
      };
      if (persona && persona.referenceImageUrls.length) {
        shot.reference = { images: persona.referenceImageUrls, seed: persona.lockedSeed ?? undefined };
      }
      return shot;
    });

    return {
      model,
      durationSec,
      shots,
      captionSuggestion: this.caption(brief),
      qcChecklist: this.qcChecklist(persona),
    };
  }

  /** Per-model prompt formatting. Identity-lock phrasing injected when a persona is present. */
  buildModelPrompt(model: VideoModel, sceneDesc: string, persona?: PersonaLock): string {
    const identity = persona
      ? `consistent identity (same face, hair, outfit as reference${persona.lockedSeed != null ? `, seed ${persona.lockedSeed}` : ''}), `
      : '';
    const base = `${identity}${sceneDesc}, vertical 9:16`;
    switch (model) {
      case 'seedance':
        return `${base}, cinematic, native synchronized audio, reference-to-video`;
      case 'veo':
        return `${base}, photorealistic, natural lighting, subtle camera motion`;
      case 'kling':
        return `${base}, smooth motion, high detail, 1080p`;
      case 'higgsfield':
        return `${base}, Marketing Studio DTC ad style, brand-safe`;
      default:
        return base;
    }
  }

  private caption(b: VideoBrief): string {
    const offer = b.offer ? ` ${b.offer}` : '';
    return `${b.hook ?? b.product}${offer} — link in bio.`;
  }

  private qcChecklist(persona?: PersonaLock): string[] {
    const base = [
      'faces/text not distorted',
      'brand logo + palette correct',
      'aspect 9:16, duration within target',
      'no prohibited/medical claims',
      'AI-content disclosure per platform',
    ];
    if (persona) base.unshift(`persona "${persona.name}" identity consistent across all shots`);
    return base;
  }
}

const SCENES: SceneSpec[] = [
  {
    scene: 'Hook (0-3s)',
    camera: 'tight close-up, fast cut-in',
    vo: (b) => b.hook ?? `Is ${b.product} what you're missing?`,
    desc: (b) => `attention-grabbing opener about ${b.product}${b.audience ? ` for ${b.audience}` : ''}`,
  },
  {
    scene: 'Problem / demo (3-8s)',
    camera: 'product demo, medium shot',
    vo: (b) => `Here's how ${b.product} actually works.`,
    desc: (b) => `demonstration of ${b.product} solving the viewer's problem`,
  },
  {
    scene: 'Social proof (8-12s)',
    camera: 'testimonial framing',
    vo: () => `Real results people trust.`,
    desc: (b) => `credible social proof / testimonial for ${b.product}`,
  },
  {
    scene: 'CTA (12-15s)',
    camera: 'direct-to-camera',
    vo: (b) => `${b.offer ?? 'Book now'} — tap the link.`,
    desc: (b) => `clear call to action${b.offer ? `: ${b.offer}` : ''}`,
  },
];
