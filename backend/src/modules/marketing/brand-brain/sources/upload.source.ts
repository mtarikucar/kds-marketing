import { Injectable, Logger } from '@nestjs/common';
import { R2StorageService } from '../../../../common/storage/r2-storage.service';
import { BrandSource, BrandSourceInput, BrandSourceResult } from './brand-source';

async function streamToString(stream: import('stream').Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Classifies the wizard's already-uploaded R2 objects: images become
 * BrandKit-candidate URLs (via `r2.urlForKey()` — a PUBLIC method, no fetch);
 * text-ish files (.txt/.md/.csv/.json) are read via `r2.getObjectStream()`;
 * other/binary files (PDF etc.) are recorded with the key only — text
 * extraction is deferred. Inert when R2 is unconfigured or no uploadKeys
 * were supplied. Per-key read failure is isolated: one bad key never fails
 * the whole source. No metering — this is owned R2 storage, not a paid
 * third-party call.
 */
@Injectable()
export class UploadBrandSource implements BrandSource {
  readonly source = 'uploads' as const;
  private readonly logger = new Logger(UploadBrandSource.name);
  constructor(private readonly r2: R2StorageService) {}

  async collect(_workspaceId: string, input: BrandSourceInput): Promise<BrandSourceResult> {
    const keys = input.uploadKeys ?? [];
    if (!this.r2.isConfigured() || !keys.length) {
      return { source: this.source, status: 'inert', raw: null };
    }
    const images: Array<{ key: string; url: string }> = [];
    const docs: Array<{ key: string; text: string; note?: string }> = [];
    for (const key of keys) {
      if (/\.(png|jpe?g|webp|gif|svg)$/i.test(key)) {
        images.push({ key, url: this.r2.urlForKey(key) });
        continue;
      }
      if (/\.(txt|md|csv|json)$/i.test(key)) {
        try {
          const { body } = await this.r2.getObjectStream(key);
          const text = await streamToString(body);
          docs.push({ key, text: text.slice(0, 20_000) });
        } catch (e) {
          this.logger.warn(`upload read ${key} failed: ${e instanceof Error ? e.message : e}`);
          docs.push({ key, text: '', note: 'read failed' });
        }
      } else {
        docs.push({ key, text: '', note: 'binary — text extraction deferred' });
      }
    }
    return { source: this.source, status: 'ok', raw: { images, docs } };
  }
}
