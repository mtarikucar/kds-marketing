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
  /**
   * Words the viewer READS, kept separate from the words they hear.
   *
   * The two are not the same channel and routinely disagree: the reference
   * concept this seam was built for opens on a silent tracking shot with
   * "Bunun motoru yok." burned into frame. Folding on-screen text into
   * `voiceover` would either invent narration for a silent shot or drop the
   * only line in it. Undefined on the built-in ad template, which has never
   * had a text layer.
   */
  onScreenText?: string;
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

/**
 * A caller-supplied scene — the seam that lets a CONCEPT drive the plan.
 *
 * `SCENES` below is a fixed hook -> demo -> proof -> CTA template: for one
 * brief it returns the same four scenes every time, which is correct for a UGC
 * ad and wrong for "several genuinely different angles on one idea" (five calls
 * would return five identical structures with the product name swapped). The
 * creative decision — how many shots, what happens in each, what is read and
 * what is heard — therefore comes from the caller, while everything this
 * service already owns (per-model prompt formatting, persona identity-lock
 * threaded into EVERY shot, caption, QC checklist) keeps applying unchanged.
 *
 * Plain data, deliberately, not `SceneSpec`'s closures: this shape has to
 * survive a round trip through an LLM tool-call payload and a JSONB column.
 */
export interface ConceptScene {
  /** Human label for the beat — the owner writes these as time ranges ("0-2s"). */
  scene: string;
  cameraNote: string;
  /** See {@link Shot.onScreenText}. */
  onScreenText?: string;
  /** May legitimately be empty: a purely visual beat has nothing to hear. */
  voiceover: string;
  /** What is IN frame. Becomes the model prompt via `buildModelPrompt`. */
  description: string;
  /** This beat's own length. Omitted = the plan's even split, as before. */
  durationSec?: number;
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
  planShots(
    brief: VideoBrief,
    model: VideoModel = 'seedance',
    persona?: PersonaLock,
    scenes?: ConceptScene[],
  ): ShotPlan {
    const target = brief.durationSec ?? 15;
    // An explicitly-supplied empty list is a caller that produced nothing, and
    // falling through to SCENES would hand back a generic hook/demo/proof/CTA
    // ad while calling it the caller's concept. Error is not emptiness.
    if (scenes && scenes.length === 0) {
      throw new Error('planShots needs at least one scene when a scene list is supplied');
    }
    const specs: Array<ConceptScene | SceneSpec> = scenes ?? SCENES;
    const per = Math.max(2, Math.round(target / specs.length));

    const shots: Shot[] = specs.map((s, i) => {
      const custom = 'description' in s ? s : undefined;
      const desc = custom ? custom.description : (s as SceneSpec).desc(brief);
      const shot: Shot = {
        ord: i,
        scene: s.scene,
        voiceover: custom ? custom.voiceover : (s as SceneSpec).vo(brief),
        prompt: this.buildModelPrompt(model, desc, persona),
        durationSec: custom?.durationSec ?? per,
        cameraNote: custom ? custom.cameraNote : (s as SceneSpec).camera,
      };
      if (custom?.onScreenText !== undefined) shot.onScreenText = custom.onScreenText;
      if (persona && persona.referenceImageUrls.length) {
        shot.reference = { images: persona.referenceImageUrls, seed: persona.lockedSeed ?? undefined };
      }
      return shot;
    });

    return {
      model,
      // A concept's length is what its beats actually add up to. The template
      // path keeps reporting the requested duration, because its even split is
      // a rounding of that number rather than an independent decision (30s over
      // 4 scenes is 4x8, and reporting 32 there would be a regression).
      durationSec: scenes ? shots.reduce((n, sh) => n + sh.durationSec, 0) : target,
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
