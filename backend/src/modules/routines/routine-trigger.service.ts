import { Injectable, Logger } from '@nestjs/common';
import { RoutineConfigService } from './routine-config.service';

export type TriggerSource = 'manual' | 'schedule' | 'event';

export interface TriggerResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

/**
 * Fires the claude.ai "Call via API" trigger for a given routine key.
 *
 * Gating rules:
 *   - manual: always fires (ignores enabled)
 *   - schedule/event: require enabled=true
 *   - event: also respects eventCooldownSec since lastTriggeredAt
 *
 * `fire()` is the ONLY method coupled to the exact claude.ai HTTP contract.
 * If the endpoint shape changes, only fire() needs updating.
 */
@Injectable()
export class RoutineTriggerService {
  private readonly logger = new Logger(RoutineTriggerService.name);
  private readonly FIRE_TIMEOUT_MS = 30_000;

  constructor(private readonly routineConfigService: RoutineConfigService) {}

  async trigger(key: string, source: TriggerSource): Promise<TriggerResult> {
    const config = await this.routineConfigService.get(key);

    if (!config) {
      const msg = `routine config not found: ${key}`;
      this.logger.error(msg);
      return { ok: false, error: msg };
    }

    // ── enabled gating (manual bypasses) ────────────────────────────────────
    if (source !== 'manual' && !config.enabled) {
      const reason = `routine ${key} is disabled — skipping ${source} trigger`;
      this.logger.debug(reason);
      return { ok: false, skipped: reason };
    }

    // ── event cooldown ───────────────────────────────────────────────────────
    if (source === 'event' && config.lastTriggeredAt) {
      const elapsedSec = (Date.now() - config.lastTriggeredAt.getTime()) / 1000;
      if (elapsedSec < config.eventCooldownSec) {
        const remaining = Math.ceil(config.eventCooldownSec - elapsedSec);
        const reason = `routine ${key} in cooldown — ${remaining}s remaining`;
        this.logger.debug(reason);
        return { ok: false, skipped: reason };
      }
    }

    // ── require triggerUrl ───────────────────────────────────────────────────
    if (!config.triggerUrl) {
      const msg = 'no trigger url configured';
      this.logger.error(`routine ${key}: ${msg}`);
      await this.routineConfigService.recordTrigger(key, 'error', msg);
      return { ok: false, error: msg };
    }

    // ── resolve token + fire ─────────────────────────────────────────────────
    const token = this.routineConfigService.resolveToken(config);

    return this.fire(config.triggerUrl, token, source, key);
  }

  /**
   * The ONLY method coupled to claude.ai's "Call via API" contract:
   *   POST <triggerUrl>
   *   Authorization: Bearer <token>
   *   Content-Type: application/json
   *   Body: { source }
   *
   * Mirrors the AbortSignal.timeout + try/catch pattern from
   * http-core-provisioning.client.ts.
   */
  async fire(
    url: string,
    token: string | null,
    source: TriggerSource,
    key: string,
  ): Promise<TriggerResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source }),
        signal: AbortSignal.timeout(this.FIRE_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = `routine trigger network error: ${(err as Error).message}`;
      this.logger.error(`routine ${key} fire failed: ${(err as Error).message}`);
      await this.routineConfigService.recordTrigger(key, 'error', msg);
      return { ok: false, error: msg };
    }

    if (response.ok) {
      this.logger.log(`routine ${key} triggered (source=${source})`);
      await this.routineConfigService.recordTrigger(key, 'ok', undefined);
      return { ok: true };
    }

    const msg = `routine trigger returned HTTP ${response.status}`;
    this.logger.error(`routine ${key} fire: ${msg}`);
    await this.routineConfigService.recordTrigger(key, 'error', msg);
    return { ok: false, error: msg };
  }
}
