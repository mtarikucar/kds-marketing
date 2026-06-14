import { Injectable, Logger } from '@nestjs/common';
import { RoutineConfigService } from './routine-config.service';
import { safeFetch, SsrfBlockedError } from '../../common/util/safe-fetch';

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

    // ── onEvent flag gating (event sources only) ─────────────────────────────
    // config.onEvent is the operator toggle for reactive/event-driven firing.
    // Disabled onEvent means the routine only runs on schedule/manual, never
    // on domain events.
    if (source === 'event' && !config.onEvent) {
      const reason = `routine ${key}: onEvent disabled`;
      this.logger.debug(reason);
      return { ok: false, skipped: reason };
    }

    // ── event cooldown ───────────────────────────────────────────────────────
    // Only apply the cooldown when the LAST fire SUCCEEDED. If it errored, we
    // allow an immediate retry so a transient failure doesn't suppress the next
    // event for the full cooldown window.
    if (
      source === 'event' &&
      config.lastTriggeredAt &&
      config.lastTriggerStatus === 'ok'
    ) {
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

    // ── fail-closed: sealed token that can't decrypt → error (never fire tokenless) ──
    if (config.triggerTokenSealed != null) {
      const token = this.routineConfigService.resolveToken(config);
      if (token === null) {
        const msg = 'trigger token could not be decrypted';
        this.logger.error(`routine ${key}: ${msg}`);
        await this.routineConfigService.recordTrigger(key, 'error', msg);
        return { ok: false, error: msg };
      }
      return this.fire(config.triggerUrl, token, source, key);
    }

    // ── no sealed token → fire tokenless ────────────────────────────────────
    return this.fire(config.triggerUrl, null, source, key);
  }

  /**
   * The ONLY method coupled to claude.ai's "Call via API" contract:
   *   POST <triggerUrl>
   *   Authorization: Bearer <token>   (omitted when token is null)
   *   Content-Type: application/json
   *   Body: { source }
   *
   * Uses safeFetch (SSRF-hardened) so the URL is validated BEFORE the token
   * is sent — internal/private hosts are blocked before any credential leaves
   * the process.
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
      response = await safeFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source }),
        timeoutMs: this.FIRE_TIMEOUT_MS,
      });
    } catch (err) {
      const blocked = err instanceof SsrfBlockedError;
      const msg = blocked
        ? `routine trigger blocked by SSRF guard: ${(err as Error).message}`
        : `routine trigger network error: ${(err as Error).message}`;
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
