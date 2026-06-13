import { Controller, Get, Header, HttpCode, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Health surface (Observability / Monitoring / Deployability / Resilience).
 *
 * Two probes, the k8s/load-balancer split:
 *
 *   GET /api/health        — LIVENESS. Process is up and the event loop is
 *                            answering. Never touches the DB, so a transient
 *                            DB blip can't trigger a pod restart loop.
 *   GET /api/health/ready  — READINESS. Can this instance serve traffic right
 *                            now? Pings the DB (`SELECT 1`); 200 when reachable,
 *                            503 when not, so the LB drains an instance whose
 *                            database connection is gone instead of black-holing
 *                            requests.
 *
 * Both are public (no auth realm) and `@SkipThrottle()` — probes fire every few
 * seconds and must not be rate-limited away. Responses are `Cache-Control:
 * no-store` so an upstream proxy never serves a stale "ok".
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  liveness() {
    return {
      status: 'ok',
      service: 'kds-marketing',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async readiness(@Res({ passthrough: true }) res: Response) {
    const startedAt = Date.now();
    let database: 'up' | 'down' = 'down';
    try {
      // Cheapest round-trip that proves the connection + query path are live.
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    const ready = database === 'up';
    res.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not-ready',
      checks: { database },
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    };
  }
}
