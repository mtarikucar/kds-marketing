import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  MediaProvider, MediaGenSubmit, MediaGenResult, MediaGenOutput,
} from './media-provider.interface';
import { billableDurationSec, getMediaModel } from '../media/media-models.config';

const RUNWARE_API = 'https://api.runware.ai/v1';
/** A positive integer from the environment, or the fallback. `Number('')` is 0
 *  and `Number('abc')` is NaN — both would abort every call at once — so a
 *  blank or mistyped value means "the default", never "no timeout". */
function envPositiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
// Bound every call, as the fal provider does: submit runs after credits are
// reserved and a hung poll would pin the scheduled-job worker.
const RUNWARE_TIMEOUT_MS = envPositiveInt('RUNWARE_TIMEOUT_MS', 30_000);
/** A poll that fails for a reason that is about the POLL, not the task — the
 *  queue is saturated, a gateway timed out, Runware is briefly down — must
 *  leave the job in flight: Runware keeps rendering and bills the result, so
 *  failing the row here would refund the customer for a clip that arrives and
 *  is paid for. The service's own age cap bounds how long this can go on. */
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODE_RE = /rateLimit|timeout|serverError|serviceUnavailable|serverUnavailable|noAvailableServer|internalServerError|unknownError|connection/i;
/** The codes Runware's own SDK normalises to "safety" — a moderation refusal,
 *  which is refunded (BLOCKED) rather than retried. Runware publishes no code
 *  catalogue of its own, so the message regex is the second line of defence. */
const SAFETY_CODES = new Set([
  'contentPolicyViolation', 'providerContentPolicyViolation', 'sensitiveContentDetected',
  'unsafeContentDetected', 'nsfwContentDetected', 'promptBlocked', 'imageBlocked', 'moderationFailed',
]);
const BLOCK_RE = /nsfw|moderat|content polic|safety|flagged|prohibited/i;

type Dims = readonly [number, number];
/** resolution → aspect → [width, height], copied from each model page's table. */
type DimsTable = Readonly<Record<string, Readonly<Record<string, Dims>>>>;

const SEEDANCE_25_DIMS: DimsTable = {
  '480p': { '16:9': [854, 480], '4:3': [752, 560], '1:1': [640, 640], '3:4': [560, 752], '9:16': [480, 854], '21:9': [992, 432] },
  '720p': { '16:9': [1280, 720], '4:3': [1112, 834], '1:1': [960, 960], '3:4': [834, 1112], '9:16': [720, 1280], '21:9': [1470, 630] },
  '1080p': { '16:9': [1920, 1080], '4:3': [1664, 1248], '1:1': [1440, 1440], '3:4': [1248, 1664], '9:16': [1080, 1920], '21:9': [2206, 946] },
};
const SEEDANCE_1_FAST_DIMS: DimsTable = {
  '480p': { '16:9': [864, 480], '4:3': [736, 544], '1:1': [640, 640], '3:4': [544, 736], '9:16': [480, 864], '21:9': [960, 416] },
  '720p': { '16:9': [1248, 704], '4:3': [1120, 832], '1:1': [960, 960], '3:4': [832, 1120], '9:16': [704, 1248], '21:9': [1504, 640] },
  '1080p': { '16:9': [1920, 1088], '4:3': [1664, 1248], '1:1': [1440, 1440], '3:4': [1248, 1664], '9:16': [1088, 1920], '21:9': [2176, 928] },
};

/**
 * The Runware wire recipe for one AIR model id. Runware normalises most of
 * fal's per-endpoint parameter names away (`positivePrompt`, `width`/`height`,
 * `inputs.frameImages` are the same on every model); what is left is which task
 * type, which sizing table, and which optional fields THIS model accepts —
 * a seed on Seedance 2.5 is not a supported parameter, `settings.audio` on Pro
 * Fast is not either. Keyed on the catalogue binding's `model`, and
 * runware.provider.contract.spec.ts asserts every binding has one.
 */
export interface RunwareRecipe {
  task: 'imageInference' | 'videoInference' | 'removeBackground';
  dims?: DimsTable;
  /** Seedance 2.5 wants an integer; Pro Fast takes a float. */
  duration?: 'integer' | 'float';
  seed: boolean;
  negativePrompt: boolean;
  /** `settings.audio` exists on this model. */
  audioSetting: boolean;
  /** Image models: fixed output size and step count. */
  imageDims?: Dims;
  steps?: number;
  /** Video models: how many frame images the model takes. */
  frameImages?: 'first' | 'firstLast';
}

export const RUNWARE_RECIPES: Readonly<Record<string, RunwareRecipe>> = {
  'bytedance:seedance@2.5': {
    task: 'videoInference', dims: SEEDANCE_25_DIMS, duration: 'integer',
    seed: false, negativePrompt: false, audioSetting: true, frameImages: 'firstLast',
  },
  'bytedance:2@2': {
    task: 'videoInference', dims: SEEDANCE_1_FAST_DIMS, duration: 'float',
    seed: true, negativePrompt: false, audioSetting: false, frameImages: 'first',
  },
  'runware:108@1': {
    task: 'imageInference', seed: true, negativePrompt: true, audioSetting: false,
    imageDims: [1024, 1024], steps: 20,
  },
  'runware:112@5': { task: 'removeBackground', seed: false, negativePrompt: false, audioSetting: false },
};

/**
 * Build the one Runware task for a submit. Exported for the contract spec: the
 * per-model wire shape is decided here and is worth pinning without a network.
 */
export function buildRunwareTask(opts: MediaGenSubmit, taskUUID: string): Record<string, unknown> {
  const catalogued = getMediaModel(opts.model);
  const binding = catalogued?.runware;
  if (!catalogued || !binding) throw new Error(`no Runware binding for ${opts.model}`);
  const recipe = RUNWARE_RECIPES[binding.model];
  if (!recipe) throw new Error(`no Runware recipe for ${binding.model}`);

  const task: Record<string, unknown> = {
    taskType: recipe.task, taskUUID, model: binding.model,
    deliveryMethod: 'async', outputType: 'URL', includeCost: true,
  };
  // Source media goes on the wire ONLY through the slots the catalogue contract
  // declares for this model — the same rule the fal provider follows. The
  // campaign engine hands its brand-kit reference images to EVERY generation,
  // video included; on a text-to-video model (no source slots) they are
  // dropped, not promoted into a first frame that turns the clip into an
  // image-to-video render of the logo.
  const slots = new Set((catalogued.contract.sources ?? []).map((src) => src.slot));
  const first = slots.has('firstImage') || slots.has('images') ? opts.sources?.images?.[0] : undefined;
  const last = slots.has('lastImage') ? opts.sources?.lastImage : undefined;

  if (recipe.task === 'removeBackground') {
    if (!first) throw new Error(`${opts.model} requires a source image`);
    // No numberResults: the removeBackground schema does not list it.
    task.inputs = { image: first };
    task.outputFormat = 'PNG'; // keeps the alpha channel
    return task;
  }

  task.numberResults = 1;

  task.positivePrompt = opts.prompt;
  if (recipe.negativePrompt && opts.negativePrompt) task.negativePrompt = opts.negativePrompt;
  if (recipe.seed && opts.seed !== undefined) task.seed = opts.seed;

  if (recipe.task === 'imageInference') {
    const [w, h] = recipe.imageDims ?? [1024, 1024];
    task.width = w;
    task.height = h;
    if (recipe.steps) task.steps = recipe.steps;
    task.outputFormat = 'PNG';
    return task;
  }

  // videoInference. The resolution tier and the length are the catalogue's:
  // the same contract the credit estimate billed against, so what is bought is
  // what was charged for.
  const c = catalogued.contract;
  const resolution = opts.resolution && c.resolution?.values.includes(opts.resolution)
    ? opts.resolution
    : (c.resolution?.default ?? '720p');
  const requested = opts.durationSec ?? 5;
  const secs = c.duration ? billableDurationSec(c.duration, requested) : requested;
  task.duration = recipe.duration === 'integer' ? Math.round(secs) : secs;

  if (recipe.frameImages && first) {
    const frames: Array<{ image: string; frame: 'first' | 'last' }> = [{ image: first, frame: 'first' }];
    if (recipe.frameImages === 'firstLast' && last) {
      frames.push({ image: last, frame: 'last' });
    }
    task.inputs = { frameImages: frames };
    // width/height cannot be combined with frameImages; the tier is named instead
    // and the aspect follows the still.
    task.resolution = resolution;
  } else {
    const table = recipe.dims?.[resolution] ?? {};
    const aspect = opts.aspectRatio && table[opts.aspectRatio] ? opts.aspectRatio : '16:9';
    const [w, h] = table[aspect] ?? [1280, 720];
    task.width = w;
    task.height = h;
  }
  if (recipe.audioSetting) task.settings = { audio: opts.generateAudio ?? true };
  return task;
}

function mimeFromUrl(url: string, fallback: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  return fallback;
}

/** Normalise one Runware result item into our outputs. Runware returns no
 *  dimensions and no duration, so the requested (contract-encoded) length is
 *  what finalize trues up against — the same rule fal's duration-less models
 *  follow. */
export function mapRunwareItem(item: any): MediaGenOutput[] {
  const out: MediaGenOutput[] = [];
  if (typeof item?.videoURL === 'string') {
    out.push({ url: item.videoURL, mime: mimeFromUrl(item.videoURL, 'video/mp4'), width: undefined, height: undefined, durationSec: undefined });
  }
  if (typeof item?.imageURL === 'string') {
    out.push({ url: item.imageURL, mime: mimeFromUrl(item.imageURL, 'image/png'), width: undefined, height: undefined, durationSec: undefined });
  }
  return out;
}

interface RunwareError { code?: string; message?: string; taskUUID?: string }

/**
 * Runware task-array REST provider. Inert until RUNWARE_API_KEY is set. Every
 * task is submitted async and polled with `getResponse`; only models with a
 * catalogue `runware` binding can be built, and the router never sends others.
 */
@Injectable()
export class RunwareProvider implements MediaProvider {
  readonly name = 'runware';
  private readonly logger = new Logger(RunwareProvider.name);

  isConfigured(): boolean {
    return !!process.env.RUNWARE_API_KEY;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`, 'Content-Type': 'application/json' };
  }

  private async post(tasks: unknown[]): Promise<{ ok: boolean; status: number; body: any }> {
    const res = await fetch(RUNWARE_API, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(tasks),
      signal: AbortSignal.timeout(RUNWARE_TIMEOUT_MS),
    });
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  }

  async submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }> {
    if (!this.isConfigured()) throw new Error('runware provider is not configured');
    const taskUUID = randomUUID();
    const task = buildRunwareTask(opts, taskUUID);
    const { ok, status, body } = await this.post([task]);
    // One task went out, so any error that came back is about it — whatever
    // taskUUID (if any) Runware stamped on it.
    const err: RunwareError | undefined = Array.isArray(body?.errors) ? body.errors[0] : undefined;
    if (!ok || err) {
      throw new Error(`runware submit failed (${status}): ${err ? `${err.code}: ${err.message}` : 'HTTP error'}`);
    }
    return { providerRequestId: taskUUID };
  }

  async getResult(requestId: string, _model: string): Promise<MediaGenResult> {
    const { ok, status, body } = await this.post([{ taskType: 'getResponse', taskUUID: requestId }]);
    const errors: RunwareError[] = Array.isArray(body?.errors) ? body.errors : [];
    // An error addressed to THIS task is terminal whatever the HTTP status said.
    const addressed = errors.find((e) => e?.taskUUID === requestId);
    if (addressed) return this.errorResult(addressed);
    // An unaddressed error is about the poll itself. A transient one (queue
    // full, gateway timeout) leaves the job in flight; a permanent one (bad
    // key) cannot be recovered by polling again.
    const unaddressed = errors.find((e) => !e?.taskUUID);
    if (unaddressed && !TRANSIENT_CODE_RE.test(unaddressed.code ?? '')) return this.errorResult(unaddressed);
    if (!ok) {
      return TRANSIENT_HTTP.has(status)
        ? { status: 'IN_PROGRESS' }
        : { status: 'FAILED', error: `runware poll failed (${status})` };
    }
    if (unaddressed) return { status: 'IN_PROGRESS' };

    const item = (Array.isArray(body?.data) ? body.data : []).find((d: any) => d?.taskUUID === requestId);
    // Nothing yet under this id and no error either: still queued. The service
    // bounds this with its own age cap, so it cannot spin forever.
    if (!item) return { status: 'IN_PROGRESS' };
    if (item.status === 'error' || item.error) {
      return this.errorResult(item.error ?? { code: 'taskFailed', message: 'runware task failed' });
    }
    if (item.status === 'processing' || item.status === 'queued') return { status: 'IN_PROGRESS' };
    if (item.NSFWContent === true) return { status: 'BLOCKED', error: 'runware flagged the output as NSFW' };

    const outputs = mapRunwareItem(item);
    if (!outputs.length) {
      return item.status === 'success'
        ? { status: 'FAILED', error: 'runware returned no output' }
        : { status: 'IN_PROGRESS' };
    }
    return { status: 'COMPLETED', outputs, costUsd: typeof item.cost === 'number' ? item.cost : undefined };
  }

  private errorResult(e: RunwareError): MediaGenResult {
    const message = `${e.code ?? 'error'}: ${e.message ?? 'unknown runware error'}`;
    const blocked = (e.code !== undefined && SAFETY_CODES.has(e.code)) || BLOCK_RE.test(e.message ?? '');
    if (!blocked) this.logger.warn(`runware task failed: ${message}`);
    return { status: blocked ? 'BLOCKED' : 'FAILED', error: message };
  }
}
