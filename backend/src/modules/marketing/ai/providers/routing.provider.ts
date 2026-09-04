import { Injectable } from '@nestjs/common';
import { MediaProvider, MediaGenSubmit, MediaGenResult } from './media-provider.interface';
import { FalProvider } from './fal.provider';
import { RunwareProvider } from './runware.provider';
import { getMediaModel } from '../media/media-models.config';

/**
 * Runware request ids are prefixed on the row so polling routes by ID, never by
 * model: a job submitted to fal before the Runware key existed keeps being
 * polled at fal after it does. fal ids stay bare, so old rows and the fal
 * webhook's `request_id` lookup are untouched.
 */
export const RUNWARE_REQUEST_PREFIX = 'runware:';

/**
 * Per-model dispatch behind MEDIA_PROVIDER.
 *
 * fal is the base: every catalogued model can run there, so "configured" means
 * fal is. A model with a catalogue `runware` binding goes to Runware while
 * RUNWARE_API_KEY is set; with the key unset nothing changes hands. There is
 * deliberately NO fallback from a failed Runware submit to fal — the two are
 * priced differently and the reservation path already refunds a failed submit —
 * so an operator turns Runware off by unsetting the key, not by waiting for it
 * to fail.
 */
@Injectable()
export class RoutingMediaProvider implements MediaProvider {
  /** Never persisted: the service records `resolveName(model)` on the row. */
  readonly name = 'router';

  constructor(
    private readonly fal: FalProvider,
    private readonly runware: RunwareProvider,
  ) {}

  isConfigured(): boolean {
    return this.fal.isConfigured();
  }

  resolveName(model: string): string {
    return this.runware.isConfigured() && getMediaModel(model)?.runware ? 'runware' : 'fal';
  }

  async submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }> {
    if (this.resolveName(opts.model) === 'runware') {
      const r = await this.runware.submit(opts);
      return { providerRequestId: `${RUNWARE_REQUEST_PREFIX}${r.providerRequestId}` };
    }
    return this.fal.submit(opts);
  }

  getResult(requestId: string, model: string): Promise<MediaGenResult> {
    if (requestId.startsWith(RUNWARE_REQUEST_PREFIX)) {
      return this.runware.getResult(requestId.slice(RUNWARE_REQUEST_PREFIX.length), model);
    }
    return this.fal.getResult(requestId, model);
  }
}
