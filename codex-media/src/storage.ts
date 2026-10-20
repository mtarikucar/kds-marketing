import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { R2Config } from './config.js';

export const KEY_PREFIX = 'codex-media/';

export interface Storage {
  /** Stores the object and returns its public URL. */
  upload(key: string, body: Buffer, contentType: string): Promise<string>;
  /** Deletes `codex-media/` objects older than maxAgeMs; returns how many. */
  sweep?(maxAgeMs: number, now?: number): Promise<number>;
}

/** Same bucket and env names as backend/src/common/storage/r2-storage.service.ts. */
export class R2Storage implements Storage {
  readonly #client: S3Client;
  constructor(private readonly c: R2Config, client?: S3Client) {
    this.#client = client ?? new S3Client({
      region: 'auto',
      endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.#client.send(new PutObjectCommand({
      Bucket: this.c.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=86400',
    }));
    return `${this.c.publicBaseUrl}/${key}`;
  }

  /** The backend re-uploads every result under its workspace key, so these are temporary copies (§1.5). */
  async sweep(maxAgeMs: number, now = Date.now()): Promise<number> {
    let token: string | undefined;
    let deleted = 0;
    do {
      const page = await this.#client.send(new ListObjectsV2Command({ Bucket: this.c.bucket, Prefix: KEY_PREFIX, ContinuationToken: token }));
      const old = (page.Contents ?? []).filter((o) => o.Key && o.LastModified && now - o.LastModified.getTime() > maxAgeMs);
      if (old.length) {
        await this.#client.send(new DeleteObjectsCommand({ Bucket: this.c.bucket, Delete: { Objects: old.map((o) => ({ Key: o.Key! })), Quiet: true } }));
        deleted += old.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

/** CODEX_MEDIA_R2_DRYRUN=1: write to a local directory, return a file:// URL. For local trials only. */
export class DryRunStorage implements Storage {
  constructor(private readonly dir: string) {}
  async upload(key: string, body: Buffer): Promise<string> {
    const path = resolve(join(this.dir, key));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return pathToFileURL(path).href;
  }
}
