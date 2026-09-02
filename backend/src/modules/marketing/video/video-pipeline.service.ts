import { Injectable } from '@nestjs/common';

export type VideoModel = 'seedance' | 'veo' | 'kling' | 'higgsfield';

/**
 * The frame the plan is shot in.
 *
 * WHERE THIS INTENT LIVES, and why it is here rather than on the campaign or on
 * the destination account:
 *
 *  - **The plan is what a human approves.** A reviewer reads the shot plan and
 *    decides; a ratio that is not in the plan is a ratio nobody chose. It was
 *    already claimed here twice — `buildModelPrompt` appended the literal words
 *    "vertical 9:16" to every prompt and `qcChecklist` listed "aspect 9:16" —
 *    so this field does not add a concept, it makes an existing claim real.
 *  - **Only here can the words and the wire parameter agree by construction.**
 *    Both the prompt text and the QC line are generated from this one value, and
 *    the producer sends this same value as the `aspect_ratio` parameter. Prose
 *    asking for vertical while the parameter is absent — every clip this line
 *    has ever bought — is exactly the disagreement that is now impossible.
 *  - **The campaign cannot hold it.** One campaign fans one clip out to N target
 *    accounts, and the clip is BOUGHT ONCE. A campaign targeting a TikTok
 *    account and a LinkedIn page has two natural frames and one file, so the
 *    frame has to be settled where the file is specified: per plan, per beat set.
 *  - **The destination network cannot hold it either**, for the same reason, and
 *    for one more: a concept may be planned before it is scoped to any campaign
 *    at all, so at planning time there is often no destination to ask.
 *
 * The destination still gets its say — it just says it by choosing the plan's
 * ratio, not by overruling it later.
 */
export const SHOT_ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:5', '4:3', '3:4', '21:9'] as const;
export type ShotAspectRatio = (typeof SHOT_ASPECT_RATIOS)[number];

/** Vertical. What Reels, TikTok and Stories are, and what this pipeline has
 *  claimed in prose since it shipped. */
export const DEFAULT_SHOT_ASPECT: ShotAspectRatio = '9:16';

export function isShotAspectRatio(value: string): value is ShotAspectRatio {
  return (SHOT_ASPECT_RATIOS as readonly string[]).includes(value);
}

/** The word a prompt uses for a ratio, derived from the ratio rather than
 *  hardcoded beside it — "vertical 16:9" is the defect this file had, spelled
 *  the other way round. */
export function aspectOrientation(ratio: string): 'vertical' | 'horizontal' | 'square' {
  const [w, h] = ratio.split(':').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === h) return 'square';
  return w < h ? 'vertical' : 'horizontal';
}

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

/**
 * WHAT THIS PLAN WILL ACTUALLY BUY — the endpoint, the frame, the seconds and
 * the price — recorded on the plan a human approves.
 *
 * `ShotPlan.model` is a PROMPT-FORMAT label ('seedance', 'veo'): it decides how
 * the prompt string is worded and nothing else. The thing that is charged for is
 * a catalogued fal endpoint at a per-second rate, resolved from `campaign
 * override ?? workspace default ?? platform constant` — and, when the plan
 * carries persona reference frames, REPLACED by the one endpoint whose contract
 * takes an array of them. That replacement is a 16x change in the per-second
 * rate (3 credits/s → 48) and a 4-second contract floor under beats a reviewer
 * approved at 3, and it used to happen inside the producer, after approval, as a
 * `logger.log`. A 5-beat 15-second concept went from 45 credits to 960 — real
 * cash on the engine path — and nothing the payer could read said so.
 *
 * So the substitution is decided where the plan is MADE, and its consequences
 * are written here: the model that will run, why it is that one, the frame that
 * will be requested, the seconds that will be billed, and the quote. The
 * reviewer approves the thing that will be bought.
 */
export interface ShotProduction {
  /** The catalogued model id that will actually run. */
  model: string;
  /** Why this one. `persona` means the reference frames forced it. */
  modelSource: 'campaign' | 'workspace' | 'platform' | 'persona';
  /** The model that WOULD have run, when `persona` replaced it. */
  replacedModel?: string;
  /**
   * The ratio the producer will send, or null when the model takes none — in
   * which case the clip is framed by the endpoint's own default and
   * {@link frameNote} says so. Null is not a failure: a plan is not thrown away
   * because the chosen endpoint has no frame parameter.
   */
  aspectRatio: string | null;
  /** Present whenever the frame that will be requested is not the plan's own. */
  frameNote?: string;
  /** Seconds that will be BILLED per beat, in beat order. A model's contract
   *  floor raises a 3-second beat to 4 and charges for 4; the beats above carry
   *  these same numbers, so the plan and the invoice cannot disagree. */
  billedSecPerBeat: number[];
  /** The whole plan's billed length. */
  billedSec: number;
  /** The quote, at the rate that will be charged. `credits` is the customer's
   *  meter; `usd` is the vendor cost the engine path pre-debits in real cash. */
  credits: number;
  usd: number;
}

export interface ShotPlan {
  model: VideoModel;
  /** See {@link SHOT_ASPECT_RATIOS}. The frame every beat is rendered in, and
   *  the value the producer sends as the model's `aspect_ratio` parameter.
   *  Optional on the TYPE only so a plan persisted before this field existed
   *  still parses; every plan made from now on carries one. */
  aspectRatio?: ShotAspectRatio;
  /** See {@link ShotProduction}. Optional on the TYPE only for plans persisted
   *  before it existed; the producer records one on those the first time it
   *  runs them, so no plan stays silent about what it bought. */
  production?: ShotProduction;
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
    aspectRatio: ShotAspectRatio = DEFAULT_SHOT_ASPECT,
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
        prompt: this.buildModelPrompt(model, desc, persona, aspectRatio),
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
      aspectRatio,
      // A concept's length is what its beats actually add up to. The template
      // path keeps reporting the requested duration, because its even split is
      // a rounding of that number rather than an independent decision (30s over
      // 4 scenes is 4x8, and reporting 32 there would be a regression).
      durationSec: scenes ? shots.reduce((n, sh) => n + sh.durationSec, 0) : target,
      shots,
      captionSuggestion: this.caption(brief),
      qcChecklist: this.qcChecklist(persona, aspectRatio),
    };
  }

  /**
   * Per-model prompt formatting. Identity-lock phrasing injected when a persona
   * is present, and the plan's frame stated in the words the model reads.
   *
   * The ratio is a PARAMETER, not prose — `aspectRatio` is what actually decides
   * the frame. It is repeated here anyway, from the same value, because a model
   * that is told "vertical 9:16" composes for a vertical frame rather than
   * cropping a horizontal composition into one. What must never happen again is
   * the two disagreeing, which is why this takes the ratio instead of hardcoding
   * one.
   */
  buildModelPrompt(
    model: VideoModel,
    sceneDesc: string,
    persona?: PersonaLock,
    aspectRatio: ShotAspectRatio = DEFAULT_SHOT_ASPECT,
  ): string {
    const identity = persona
      ? `consistent identity (same face, hair, outfit as reference${persona.lockedSeed != null ? `, seed ${persona.lockedSeed}` : ''}), `
      : '';
    const base = `${identity}${sceneDesc}, ${aspectOrientation(aspectRatio)} ${aspectRatio}`;
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

  private qcChecklist(persona?: PersonaLock, aspectRatio: ShotAspectRatio = DEFAULT_SHOT_ASPECT): string[] {
    const base = [
      'faces/text not distorted',
      'brand logo + palette correct',
      `aspect ${aspectRatio}, duration within target`,
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
