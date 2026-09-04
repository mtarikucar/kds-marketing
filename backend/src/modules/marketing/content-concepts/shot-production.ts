import {
  billableDurationSec,
  resolveMediaModelId,
  estimateMediaCredits,
  estimateMediaUsd,
  getMediaModel,
  mediaModelAspectOptions,
  mediaModelOffersAspect,
} from '../ai/media/media-models.config';
import {
  DEFAULT_SHOT_ASPECT,
  type ShotPlan,
  type ShotProduction,
} from '../video/video-pipeline.service';

/**
 * The model a plan will run on, and WHY that one.
 *
 * Resolved from the database (`ConceptPromotionService.resolveVideoModel`) and
 * handed here, so the arithmetic below is pure and can be asserted directly.
 */
export interface VideoModelChoice {
  model: string;
  modelSource: ShotProduction['modelSource'];
  replacedModel?: string;
}

/**
 * The generation ceiling a beat is submitted under.
 *
 * Restated as a literal rather than imported from `MediaGenService`, which is
 * the same choice {@link MIN_SHOT_SEC}/{@link MAX_SHOT_SEC} in
 * `content-concepts.service.ts` already makes and for the same reason: a quote
 * is written at PLANNING time, and an env var's value then need not be its value
 * when the clip is finally bought. If the two ever disagree the customer is
 * quoted the longer beat, which is the safe direction — the quote can only be
 * dearer than the bill, never cheaper.
 */
const SUBMIT_MAX_SEC = 10;

/**
 * What one beat will actually be billed for on this model: the plan's own
 * length, put through the submission ceiling and then through the model's OWN
 * duration contract.
 *
 * The contract is the half that surprises. Seedance 2.5 — the endpoint a persona
 * plan is routed to — has a FLOOR of 4 seconds, so a beat a reviewer approved at
 * 3 seconds renders 4 and is charged 4. `billableDurationSec` is the same
 * function `buildFalInput` encodes onto the wire with and the same one
 * `estimateMediaCredits` prices, so the number on the plan is the number that is
 * bought and the number that is charged.
 */
export function billedBeatSec(model: string, requestedSec: number | undefined): number {
  // The model that will RUN: a stored id fal has retired renders on its
  // successor, whose floor and ceiling are what the invoice will show.
  const contract = getMediaModel(resolveMediaModelId(model))?.contract.duration;
  const asked = Math.min(Math.max(1, Math.round(requestedSec ?? 5)), SUBMIT_MAX_SEC);
  return contract ? billableDurationSec(contract, asked) : asked;
}

/**
 * The quote for a plan on a model — the whole of {@link ShotProduction}.
 *
 * Per beat, because that is how it is bought: one beat is one generation is one
 * charge, and a five-beat concept is five of them. Summed per beat rather than
 * priced off the total length because every rate in the catalogue rounds UP per
 * generation, and pricing 5 x 3s as one 15s clip quotes less than the five
 * requests will cost.
 */
export function quoteProduction(plan: ShotPlan, choice: VideoModelChoice): ShotProduction {
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  const billedSecPerBeat = shots.map((sh) => billedBeatSec(choice.model, sh.durationSec));

  const wanted = plan.aspectRatio ?? DEFAULT_SHOT_ASPECT;
  const offers = mediaModelOffersAspect(choice.model, wanted);
  const options = mediaModelAspectOptions(choice.model);

  // A frame that cannot be REQUESTED is not a reason to throw approved work
  // away — it is a fact about the file that comes back, and the reviewer is
  // owed the sentence rather than a failed item. `veed/avatars/text-to-video`
  // takes no ratio at all (its avatars are framed by their id); a model that
  // publishes an enum without this ratio can no longer be chosen for a campaign
  // (`assertModelOffersAspect` refuses it at that door), but a plan made before
  // that door existed still has to produce something.
  const frameNote = offers
    ? undefined
    : options.length
      ? `${choice.model} publishes ${options.join(', ')} and not ${wanted}, so no ratio is sent and the model frames the clip itself.`
      : `${choice.model} takes no aspect ratio, so the clip is framed by the endpoint itself rather than by the plan's ${wanted}.`;

  // The SAME estimate inputs `MediaGenService.requestGeneration` will build for
  // each beat — the length, and the prompt's own length, which is what a
  // script-metered model (the avatar endpoints) is actually billed on. Quoting
  // on duration alone would price those beats at a number nobody is charged.
  const beatOpts = billedSecPerBeat.map((sec, i) => ({
    durationSec: sec,
    textLength: (shots[i]?.prompt ?? '').length,
  }));

  return {
    model: choice.model,
    modelSource: choice.modelSource,
    ...(choice.replacedModel ? { replacedModel: choice.replacedModel } : {}),
    aspectRatio: offers ? wanted : null,
    ...(frameNote ? { frameNote } : {}),
    billedSecPerBeat,
    billedSec: billedSecPerBeat.reduce((n, sec) => n + sec, 0),
    credits: beatOpts.reduce((n, opts) => n + estimateMediaCredits(choice.model, opts), 0),
    usd: beatOpts.reduce((n, opts) => n + estimateMediaUsd(choice.model, opts), 0),
  };
}

/**
 * The plan a human will be shown, with the purchase written into it.
 *
 * Two things change on the way through, and both are the same principle — the
 * plan must describe the thing that will be bought:
 *
 *  - **The beats carry their BILLED length.** A 3-second beat on a model with a
 *    4-second floor renders and bills 4 seconds. Leaving 3 on the plan means the
 *    approved plan describes a file that does not exist and a price nobody will
 *    be charged.
 *  - **The plan's total is the sum of those beats**, for the same reason.
 *
 * The creative content — every scene, prompt, voiceover, camera note — is
 * untouched. This does not rewrite what was planned; it states what it costs.
 */
export function withProduction(plan: ShotPlan, choice: VideoModelChoice): ShotPlan {
  const production = quoteProduction(plan, choice);
  const shots = (Array.isArray(plan.shots) ? plan.shots : []).map((sh, i) => ({
    ...sh,
    durationSec: production.billedSecPerBeat[i] ?? sh.durationSec,
  }));
  return {
    ...plan,
    shots,
    durationSec: production.billedSec,
    production,
  };
}
