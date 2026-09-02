import { Injectable, Logger } from '@nestjs/common';
import {
  MediaProvider, MediaGenSubmit, MediaGenResult, MediaGenOutput, MediaGenStatus,
} from './media-provider.interface';
import {
  getMediaModel, billableDurationSec,
  MediaInputContract, MediaDurationContract, MediaSourceContract,
} from '../media/media-models.config';

const FAL_QUEUE_BASE = 'https://queue.fal.run';
const BLOCK_RE = /nsfw|moderat|content polic|safety|flagged|prohibited/i;
// Bound every fal call so a hung connection can't block the HTTP request path
// (submit, after credits are reserved) or a scheduled-job poll tick indefinitely.
const FAL_TIMEOUT_MS = Number(process.env.FAL_TIMEOUT_MS ?? 30_000);

/** The contract used for an id the catalogue does not know. Prompt-only is the
 *  narrowest thing that can still succeed: it can never send a parameter the
 *  endpoint rejects. (The service refuses uncatalogued ids anyway — this is the
 *  belt to that braces.) */
const UNKNOWN_MODEL_CONTRACT: MediaInputContract = {
  promptParam: 'prompt', negativePrompt: false, seedInput: false,
};

/** Encode a duration the way THIS model wants it. There is deliberately no
 *  shared coercion: an integer into Seedance 2.5's digit-string enum, or "8"
 *  into Veo's "8s", is a 422 at the API rather than a coerced value. */
function encodeDuration(c: MediaDurationContract, requestedSec: number): string | number {
  // Clamped and snapped DOWN by the catalogue's own helper — the SAME one the
  // credit estimate bills against, so the number on the wire and the number the
  // customer was charged for can never be two different lengths.
  const secs = billableDurationSec(c, requestedSec);
  switch (c.encoding) {
    case 'digitStringSeconds': return String(secs);
    case 'suffixedSeconds': return `${secs}s`;
    case 'milliseconds': return secs * 1000;
    case 'floatSeconds':
    case 'integerSeconds':
    default: return secs;
  }
}

/** Resolve one source requirement out of the caller's role-keyed sources. */
function resolveSource(
  req: MediaSourceContract, sources: MediaGenSubmit['sources'],
): string | string[] | undefined {
  const images = sources?.images ?? [];
  switch (req.slot) {
    case 'images': {
      const list = req.maxCount ? images.slice(0, req.maxCount) : images;
      return list.length ? list : undefined;
    }
    case 'firstImage': return images[0];
    case 'lastImage': return sources?.lastImage;
    case 'video': return sources?.video;
    case 'audio': return sources?.audio;
    case 'mask': return sources?.mask;
    default: return undefined;
  }
}

/**
 * Build the fal request body from the model's INPUT CONTRACT rather than from a
 * flat mapping. A model that does not accept a parameter never receives it —
 * which is not merely tidy: `seed` on Seedance 2.5 text-to-video and
 * `aspect_ratio` on Seedream are unsupported params, and the wrong duration TYPE
 * is a hard validation failure.
 *
 * Exported for the spec: this is where the per-model wire shape is decided, and
 * it is worth testing without a network.
 */
export function buildFalInput(opts: MediaGenSubmit): Record<string, unknown> {
  const contract = getMediaModel(opts.model)?.contract ?? UNKNOWN_MODEL_CONTRACT;
  const input: Record<string, unknown> = { ...(contract.fixed ?? {}) };

  if (contract.promptParam) input[contract.promptParam] = opts.prompt;
  if (contract.negativePrompt && opts.negativePrompt) input.negative_prompt = opts.negativePrompt;

  if (contract.aspect && opts.aspectRatio) {
    // A ratio the model does not offer is dropped, not approximated — the
    // service rejects it up front, so reaching here means it can be ignored.
    const wire = contract.aspect.values[opts.aspectRatio];
    if (wire) input[contract.aspect.param] = wire;
  }

  if (contract.resolution) {
    // Always explicit. Several fal models default to their most expensive tier,
    // and the credit estimate was taken against a specific tier.
    const { param, values, default: fallback } = contract.resolution;
    input[param] = opts.resolution && values.includes(opts.resolution) ? opts.resolution : fallback;
  }

  if (contract.duration && opts.durationSec) {
    input[contract.duration.param] = encodeDuration(contract.duration, opts.durationSec);
  }

  if (contract.audio) {
    // Also always explicit: the flag name AND its default vary per model, and
    // audio roughly doubles Veo's per-second price.
    input[contract.audio.param] = opts.generateAudio ?? contract.audio.default;
  }

  if (contract.seedInput && opts.seed !== undefined) input.seed = opts.seed;

  for (const req of contract.sources ?? []) {
    const value = resolveSource(req, opts.sources);
    if (value === undefined) {
      if (req.required) throw new Error(`fal model ${opts.model} requires a source: ${req.param}`);
      continue;
    }
    input[req.param] = req.arity === 'array'
      ? (Array.isArray(value) ? value : [value])
      : (Array.isArray(value) ? value[0] : value);
  }

  for (const [slot, choice] of Object.entries(contract.choices ?? {})) {
    const asked = opts[slot as 'voice' | 'language' | 'avatar'];
    // values: [] marks a free-form field (the TTS voice name is not an enum).
    const ok = asked && (choice.values.length === 0 || choice.values.includes(asked));
    input[choice.param] = ok ? asked : choice.default;
  }

  return input;
}

/**
 * Normalize a fal result payload into our outputs. fal has no single envelope:
 * an `images` ARRAY (most generators), a singular `image` OBJECT (Topaz,
 * BiRefNet and the rest of the finishing family), a singular `video` OBJECT
 * (every video model — never a videos[] array), or a singular `audio` OBJECT
 * (ElevenLabs). Shared with the webhook controller so both paths agree.
 */
export function mapFalOutputs(body: any): MediaGenOutput[] {
  const out: MediaGenOutput[] = [];
  const images = body?.images ?? (body?.image ? [body.image] : []);
  for (const img of images) {
    if (!img?.url) continue;
    out.push({
      url: img.url, mime: img.content_type ?? 'image/png',
      width: img.width ?? undefined, height: img.height ?? undefined, durationSec: undefined,
    });
  }
  const videos = body?.video ? [body.video] : (body?.videos ?? []);
  for (const v of videos) {
    if (!v?.url) continue;
    out.push({
      url: v.url, mime: v.content_type ?? 'video/mp4', width: v.width, height: v.height,
      // Kling's avatar endpoints report the length at the TOP level rather than
      // on the file — and since the caller cannot set that length, this figure is
      // the only thing the credit true-up can key off.
      durationSec: v.duration ?? body?.duration,
    });
  }
  const audios = body?.audio ? [body.audio] : (body?.audios ?? []);
  for (const a of audios) {
    if (!a?.url) continue;
    out.push({ url: a.url, mime: a.content_type ?? 'audio/mpeg', durationSec: a.duration });
  }
  return out;
}

/**
 * fal.ai queue REST provider. Inert until FAL_KEY is set (mirrors R2 fallback).
 * Submit returns a request_id; getResult polls status then fetches the result.
 * Moderation rejections map to BLOCKED (refunded), other errors to FAILED.
 */
@Injectable()
export class FalProvider implements MediaProvider {
  readonly name = 'fal';
  private readonly logger = new Logger(FalProvider.name);

  isConfigured(): boolean {
    return !!process.env.FAL_KEY;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  }

  async submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }> {
    if (!this.isConfigured()) throw new Error('fal provider is not configured');
    const input = buildFalInput(opts);

    let url = `${FAL_QUEUE_BASE}/${opts.model}`;
    if (opts.webhookUrl) url += `?fal_webhook=${encodeURIComponent(opts.webhookUrl)}`;

    const res = await fetch(url, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(input),
      signal: AbortSignal.timeout(FAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await this.readDetail(res);
      throw new Error(`fal submit failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { request_id?: string };
    if (!body.request_id) throw new Error('fal submit returned no request_id');
    return { providerRequestId: body.request_id };
  }

  async getResult(requestId: string, model: string): Promise<MediaGenResult> {
    const statusRes = await fetch(
      `${FAL_QUEUE_BASE}/${model}/requests/${requestId}/status`,
      { headers: this.headers(), signal: AbortSignal.timeout(FAL_TIMEOUT_MS) },
    );
    if (!statusRes.ok) return this.errorResult(await this.readDetail(statusRes));

    const statusBody = (await statusRes.json()) as { status?: string };
    const s = statusBody.status;
    if (s === 'IN_QUEUE' || s === 'IN_PROGRESS') return { status: s as MediaGenStatus };
    if (s !== 'COMPLETED') return this.errorResult(s ?? 'unknown fal status');

    const resultRes = await fetch(
      `${FAL_QUEUE_BASE}/${model}/requests/${requestId}`,
      { headers: this.headers(), signal: AbortSignal.timeout(FAL_TIMEOUT_MS) },
    );
    if (!resultRes.ok) return this.errorResult(await this.readDetail(resultRes));
    return { status: 'COMPLETED', outputs: mapFalOutputs(await resultRes.json()) };
  }

  private async readDetail(res: Response): Promise<string> {
    try {
      const b = (await res.json()) as any;
      return typeof b?.detail === 'string' ? b.detail : JSON.stringify(b?.detail ?? b);
    } catch { return `HTTP ${res.status}`; }
  }

  private errorResult(message: string): MediaGenResult {
    return { status: BLOCK_RE.test(message) ? 'BLOCKED' : 'FAILED', error: message };
  }
}
