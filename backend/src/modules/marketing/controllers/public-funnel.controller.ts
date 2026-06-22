import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PageFunnelsService } from '../page-funnels/page-funnels.service';

/**
 * Public multi-step funnel render (no auth). Resolves the funnel by its
 * (workspace, slug) and renders the requested step (default 0) as a self-
 * contained, JS-free HTML page via the shared SiteRendererService. Served under
 * /api/public so it works without the optional vanity-route config.
 */
@Controller('public/funnel')
export class PublicFunnelController {
  constructor(
    private readonly funnels: PageFunnelsService,
    private readonly config: ConfigService,
  ) {}

  private base(): string {
    return this.config.get<string>('PUBLIC_BASE_URL') ?? '';
  }

  @Get(':ws/:slug')
  first(@Param('ws') ws: string, @Param('slug') slug: string, @Res() res: Response): Promise<void> {
    return this.send(ws, slug, 0, res);
  }

  @Get(':ws/:slug/:step')
  step(@Param('ws') ws: string, @Param('slug') slug: string, @Param('step') step: string, @Res() res: Response): Promise<void> {
    const idx = Number.parseInt(step, 10);
    return this.send(ws, slug, Number.isFinite(idx) ? idx : 0, res);
  }

  private async send(ws: string, slug: string, idx: number, res: Response): Promise<void> {
    const html = await this.funnels.render(ws, slug, idx, this.base());
    if (!html) {
      res.status(404).type('html').send('<h1>404 — funnel step not found</h1>');
      return;
    }
    res.type('html').send(html);
  }
}
