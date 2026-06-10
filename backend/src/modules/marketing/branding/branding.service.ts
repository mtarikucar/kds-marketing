import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

const ALLOWED_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export interface Branding {
  brandName: string | null;
  accentColor: string | null;
  logoUrl: string | null;
}

/**
 * White-label-lite branding. A workspace sets its brand name + accent + logo;
 * these theme its PUBLIC surfaces (funnel pages, web-chat widget). Logos are
 * written under UPLOADS_DIR and served at /api/public/uploads/<file>.
 */
@Injectable()
export class BrandingService {
  private readonly logger = new Logger(BrandingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private uploadsDir(): string {
    return this.config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads');
  }

  async get(workspaceId: string): Promise<Branding> {
    const b = await this.prisma.workspaceBranding.findUnique({ where: { workspaceId } });
    return { brandName: b?.brandName ?? null, accentColor: b?.accentColor ?? null, logoUrl: b?.logoUrl ?? null };
  }

  async set(workspaceId: string, dto: { brandName?: string | null; accentColor?: string | null }): Promise<Branding> {
    const accentColor = dto.accentColor && /^#[0-9a-fA-F]{6}$/.test(dto.accentColor) ? dto.accentColor : dto.accentColor === null ? null : undefined;
    await this.prisma.workspaceBranding.upsert({
      where: { workspaceId },
      create: { workspaceId, brandName: dto.brandName ?? null, accentColor: accentColor ?? null },
      update: { ...(dto.brandName !== undefined ? { brandName: dto.brandName } : {}), ...(accentColor !== undefined ? { accentColor } : {}) },
    });
    return this.get(workspaceId);
  }

  async saveLogo(workspaceId: string, file?: { mimetype: string; buffer: Buffer; size: number }): Promise<Branding> {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = ALLOWED_EXT[file.mimetype];
    if (!ext) throw new BadRequestException('Logo must be PNG, JPEG, WEBP or SVG');
    if (file.size > 1_000_000) throw new BadRequestException('Logo must be under 1 MB');
    const dir = this.uploadsDir();
    await fs.mkdir(dir, { recursive: true });
    const filename = `${workspaceId}-${randomBytes(6).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(dir, filename), file.buffer);
    const logoUrl = `/api/public/uploads/${filename}`;
    await this.prisma.workspaceBranding.upsert({
      where: { workspaceId },
      create: { workspaceId, logoUrl },
      update: { logoUrl },
    });
    return this.get(workspaceId);
  }

  /** Read an uploaded asset for the public serve route (path-traversal safe). */
  async readUpload(filename: string): Promise<{ data: Buffer; contentType: string } | null> {
    if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename.includes('..')) return null;
    const ext = filename.split('.').pop()?.toLowerCase();
    const contentType = Object.entries(ALLOWED_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    try {
      const data = await fs.readFile(path.join(this.uploadsDir(), filename));
      return { data, contentType };
    } catch {
      return null;
    }
  }
}
