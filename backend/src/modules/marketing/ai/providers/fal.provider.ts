import { Injectable, Logger } from '@nestjs/common';
import {
  MediaProvider, MediaGenSubmit, MediaGenResult, MediaGenOutput, MediaGenStatus,
} from './media-provider.interface';

const FAL_QUEUE_BASE = 'https://queue.fal.run';
const BLOCK_RE = /nsfw|moderat|content polic|safety|flagged|prohibited/i;
// Bound every fal call so a hung connection can't block the HTTP request path
// (submit, after credits are reserved) or a scheduled-job poll tick indefinitely.
const FAL_TIMEOUT_MS = Number(process.env.FAL_TIMEOUT_MS ?? 30_000);

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
    const input: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;
    if (opts.aspectRatio) input.aspect_ratio = opts.aspectRatio;
    if (opts.durationSec) input.duration = opts.durationSec;
    if (opts.referenceImageUrls?.length) input.image_urls = opts.referenceImageUrls;
    if (opts.seed !== undefined) input.seed = opts.seed;

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
    return { status: 'COMPLETED', outputs: this.mapOutputs(await resultRes.json()) };
  }

  private mapOutputs(body: any): MediaGenOutput[] {
    const out: MediaGenOutput[] = [];
    for (const img of body?.images ?? []) {
      out.push({ url: img.url, mime: img.content_type ?? 'image/png', width: img.width, height: img.height, durationSec: undefined });
    }
    const videos = body?.video ? [body.video] : (body?.videos ?? []);
    for (const v of videos) {
      out.push({ url: v.url, mime: v.content_type ?? 'video/mp4', width: v.width, height: v.height, durationSec: v.duration });
    }
    return out;
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
