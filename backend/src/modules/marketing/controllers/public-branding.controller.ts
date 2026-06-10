import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { BrandingService } from '../branding/branding.service';

/**
 * Public branding read + uploaded-asset serving (no auth). Public surfaces
 * (web-chat widget, booking/funnel pages) fetch the workspace's brand to theme
 * themselves; logos are streamed from UPLOADS_DIR (path-traversal-safe).
 */
@Controller('public')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get('branding/:ws')
  brand(@Param('ws') ws: string) {
    return this.branding.get(ws);
  }

  @Get('uploads/:file')
  async upload(@Param('file') file: string, @Res() res: Response): Promise<void> {
    const found = await this.branding.readUpload(file);
    if (!found) throw new NotFoundException('Not found');
    res.set({ 'Content-Type': found.contentType, 'Cache-Control': 'public, max-age=86400' });
    res.send(found.data);
  }
}
