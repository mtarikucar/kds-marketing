import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint — `GET /api/metrics`.
 *
 * Public and unauthenticated like the health probes: a scraper hits it on a
 * schedule and it exposes no tenant data, only aggregate counters. Kept out of
 * the Swagger surface (it's ops infra, not part of the product API).
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.scrape());
  }
}
