import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { isSttConfigured } from './voice-ai.config';

export interface SttResult {
  text: string;
  provider: string;
  language?: string;
}

export interface TranscribeOptions {
  /** Hint for providers that accept it (Deepgram detect_language overrides). */
  language?: string;
}

/**
 * Provider-agnostic speech-to-text. Inert (returns null) until STT_PROVIDER +
 * STT_API_KEY are set. Never throws to the caller — failures log a warn and
 * resolve to null so the post-call cron can simply skip the row.
 */
@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);

  async transcribeUrl(audioUrl: string, opts: TranscribeOptions = {}): Promise<SttResult | null> {
    if (!isSttConfigured()) return null;
    const provider = (process.env.STT_PROVIDER || '').trim().toLowerCase();
    try {
      if (provider === 'deepgram') return await this.transcribeDeepgram(audioUrl, opts);
      if (provider === 'openai') return await this.transcribeOpenai(audioUrl, opts);
      this.logger.warn(`unknown STT_PROVIDER: ${provider}`);
      return null;
    } catch (err) {
      this.logger.warn(`STT (${provider}) failed: ${err?.message || err}`);
      return null;
    }
  }

  private async transcribeDeepgram(audioUrl: string, opts: TranscribeOptions): Promise<SttResult | null> {
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
    const language = json?.results?.channels?.[0]?.detected_language || opts.language;
    return { text, provider: 'deepgram', language };
  }

  private async transcribeOpenai(audioUrl: string, opts: TranscribeOptions): Promise<SttResult | null> {
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
    const json = await this.fetchJson('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const text = (json?.text || '').trim();
    if (!text) return null;
    return { text, provider: 'openai', language: json?.language || opts.language };
  }

  /** Wraps safeFetch + JSON parse so tests can mock this seam. */
  private async fetchJson(url: string, init: any): Promise<any> {
    const res = await safeFetch(url, init);
    return res.json();
  }
}
