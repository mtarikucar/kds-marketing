import { PrismaService } from '../../../prisma/prisma.service';
import { assertJobProvider } from '../ai/ai-job-policy';
import { LocalInferenceService } from '../ai/local-inference.service';
import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { isSttConfigured } from './voice-ai.config';

export interface SttResult {
  text: string;
  provider: string;
  language?: string;
}

export interface TranscribeOptions {
  workspaceId?: string;
  /** Hint for providers that accept it (Deepgram detect_language overrides). */
  language?: string;
}

/**
 * Workspace calls enforce action policy before fetching anything. LOCAL failures
 * and policy failures propagate; they never select a paid provider as fallback.
 * Legacy calls without workspace options retain the configured API behavior:
 * return null when unconfigured or when that API provider fails.
 */
@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly local?: LocalInferenceService,
  ) {}

  async transcribeUrl(
    audioUrl: string,
    opts: TranscribeOptions = {},
  ): Promise<SttResult | null> {
    if (opts.workspaceId !== undefined) {
      if (
        typeof opts.workspaceId !== 'string' ||
        !opts.workspaceId.trim() ||
        !this.prisma
      ) {
        throw new ServiceUnavailableException('AI_JOB_POLICY_UNAVAILABLE');
      }
      const decision = await assertJobProvider(
        this.prisma,
        opts.workspaceId,
        'stt.minute',
      );
      if (decision.provider === 'LOCAL') {
        if (!this.local)
          throw new ServiceUnavailableException('LOCAL_AI_NOT_CONFIGURED');
        return this.local.transcribeUrl(audioUrl, opts.language);
      }
      if (decision.provider !== 'API')
        throw new ServiceUnavailableException('AI_PROVIDER_REQUIRED');
    }
    if (!isSttConfigured()) return null;
    const provider = (process.env.STT_PROVIDER || '').trim().toLowerCase();
    try {
      if (provider === 'deepgram')
        return await this.transcribeDeepgram(audioUrl, opts);
      if (provider === 'openai')
        return await this.transcribeOpenai(audioUrl, opts);
      this.logger.warn(`unknown STT_PROVIDER: ${provider}`);
      return null;
    } catch (err) {
      this.logger.warn(`STT (${provider}) failed: ${err?.message || err}`);
      return null;
    }
  }

  private async transcribeDeepgram(
    audioUrl: string,
    opts: TranscribeOptions,
  ): Promise<SttResult | null> {
    const key = (process.env.STT_API_KEY || '').trim();
    const url =
      `https://api.deepgram.com/v1/listen?url=${encodeURIComponent(audioUrl)}` +
      `&model=nova-2&detect_language=true`;
    const json = await this.fetchJson(url, {
      method: 'POST',
      headers: { Authorization: `Token ${key}` },
    });
    const alt = json?.results?.channels?.[0]?.alternatives?.[0];
    const text = (alt?.transcript || '').trim();
    if (!text) return null;
    const language =
      json?.results?.channels?.[0]?.detected_language || opts.language;
    return { text, provider: 'deepgram', language };
  }

  private async transcribeOpenai(
    audioUrl: string,
    opts: TranscribeOptions,
  ): Promise<SttResult | null> {
    const key = (process.env.STT_API_KEY || '').trim();
    // OpenAI Whisper is not URL-native: fetch the audio bytes first.
    const audioRes = await safeFetch(audioUrl, { timeoutMs: 30_000 });
    if (!audioRes.ok) {
      this.logger.warn(`openai STT: audio fetch ${audioRes.status}`);
      return null;
    }
    const bytes = await audioRes.arrayBuffer();
    const form = new FormData();
    form.append('model', 'whisper-1');
    if (opts.language) form.append('language', opts.language);
    form.append('file', new Blob([bytes]), 'audio');
    const json = await this.fetchJson(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      },
    );
    const text = (json?.text || '').trim();
    if (!text) return null;
    return {
      text,
      provider: 'openai',
      language: json?.language || opts.language,
    };
  }

  /** Wraps safeFetch + JSON parse so tests can mock this seam. */
  private async fetchJson(url: string, init: any): Promise<any> {
    const res = await safeFetch(url, init);
    return res.json();
  }
}
