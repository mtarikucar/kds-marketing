import { Injectable } from '@nestjs/common';
import { safeFetch } from '../../../../common/util/safe-fetch';

/**
 * The one door GA4 code uses to reach Google — the SSRF-safe fetch with a
 * timeout. A class of its own so the end-to-end test can stand a fake Google
 * behind it without a network or a monkey-patched global.
 */
@Injectable()
export class Ga4HttpClient {
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    return safeFetch(url, { ...init, timeoutMs: 15_000 });
  }
}
