import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

export interface UploadedMedia {
  /** Public URL Meta will pull the asset from. */
  url: string;
  /** R2 object key — retained so the asset can be deleted after publish. */
  key: string;
  /** MIME type, used downstream to pick image_url vs video_url. */
  mime: string;
}

export interface UploadInput {
  originalname?: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/**
 * Cloudflare R2 (S3-compatible) object storage for social-planner media.
 *
 * Meta publishing is pull-from-URL: every image/video/reel/story is fetched by
 * Meta from a public URL, so uploads land in an R2 bucket exposed at a public
 * base URL (`R2_PUBLIC_BASE_URL`, a custom domain or the bucket's r2.dev URL).
 * Inert (isConfigured() === false) until the R2_* env vars are set — callers
 * fall back to manual URL paste.
 */
@Injectable()
export class R2StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private client: S3Client | null = null;

  private get bucket(): string {
    return process.env.R2_BUCKET ?? '';
  }

  private get publicBase(): string {
    return (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return !!(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET &&
      process.env.R2_PUBLIC_BASE_URL
    );
  }

  private getClient(): S3Client {
    if (this.client) return this.client;
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
      },
    });
    return this.client;
  }

  private extFor(file: UploadInput): string {
    if (EXT_BY_MIME[file.mimetype]) return EXT_BY_MIME[file.mimetype];
    const fromName = file.originalname?.split('.').pop();
    return fromName && fromName.length <= 5 ? fromName.toLowerCase() : 'bin';
  }

  /** Upload one file and return its public URL + key + mime. */
  async upload(workspaceId: string, file: UploadInput): Promise<UploadedMedia> {
    if (!this.isConfigured()) {
      throw new Error('R2 storage is not configured');
    }
    const key = `social/${workspaceId}/${randomUUID()}.${this.extFor(file)}`;
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        // Long cache — Meta pulls once; objects are deleted 7 days post-publish.
        CacheControl: 'public, max-age=604800',
      }),
    );
    return { url: `${this.publicBase}/${key}`, key, mime: file.mimetype };
  }

  /** Best-effort delete of uploaded objects (post-publish cleanup). */
  async deleteKeys(keys: string[]): Promise<void> {
    const clean = keys.filter(Boolean);
    if (!clean.length || !this.isConfigured()) return;
    try {
      await this.getClient().send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: clean.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    } catch (e: any) {
      this.logger.warn(`R2 deleteKeys failed: ${e?.message ?? e}`);
    }
  }
}
