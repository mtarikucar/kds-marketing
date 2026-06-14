/**
 * RoutineTriggerService — plain-instantiation spec.
 *
 * Covers:
 *   - manual source fires even when enabled=false
 *   - schedule/event sources skip when enabled=false
 *   - event source within cooldown window is skipped
 *   - event source outside cooldown window fires
 *   - no triggerUrl → records error, returns ok:false
 *   - fetch success → records 'ok', returns ok:true
 *   - fetch network throw → records error, returns ok:false
 *   - fetch non-2xx → records error, returns ok:false
 */

import { RoutineTriggerService } from './routine-trigger.service';

// ── global fetch mock ────────────────────────────────────────────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ── helpers ──────────────────────────────────────────────────────────────────
function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'id-1',
    key: 'review-draft',
    enabled: true,
    cron: null,
    onEvent: false,
    triggerUrl: 'https://claude.ai/api/trigger/abc',
    triggerTokenSealed: 'sealed:tok',
    eventCooldownSec: 300,
    lastTriggeredAt: null,
    lastTriggerStatus: null,
    lastTriggerError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeConfigService(config = makeConfig(), token: string | null = 'plain-token') {
  return {
    get: jest.fn().mockResolvedValue(config),
    recordTrigger: jest.fn().mockResolvedValue(undefined),
    resolveToken: jest.fn().mockReturnValue(token),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('RoutineTriggerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── source gating ─────────────────────────────────────────────────────────

  describe('trigger() source gating', () => {
    it('manual source fires even when enabled=false', async () => {
      const cfg = makeConfig({ enabled: false });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await service.trigger('review-draft', 'manual');

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('schedule source skips when enabled=false', async () => {
      const cfg = makeConfig({ enabled: false });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      const result = await service.trigger('review-draft', 'schedule');

      expect(result.ok).toBe(false);
      expect(result.skipped).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(configSvc.recordTrigger).not.toHaveBeenCalled();
    });

    it('event source skips when enabled=false', async () => {
      const cfg = makeConfig({ enabled: false });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      const result = await service.trigger('review-draft', 'event');

      expect(result.ok).toBe(false);
      expect(result.skipped).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── event cooldown ────────────────────────────────────────────────────────

  describe('trigger() event cooldown', () => {
    it('event source skips when lastTriggeredAt is within cooldown', async () => {
      const lastTriggeredAt = new Date(Date.now() - 60_000); // 60s ago, cooldown=300s
      const cfg = makeConfig({ enabled: true, onEvent: true, lastTriggeredAt, eventCooldownSec: 300 });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      const result = await service.trigger('review-draft', 'event');

      expect(result.ok).toBe(false);
      expect(result.skipped).toMatch(/cooldown/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('event source fires when lastTriggeredAt is outside cooldown', async () => {
      const lastTriggeredAt = new Date(Date.now() - 400_000); // 400s ago > 300s cooldown
      const cfg = makeConfig({ enabled: true, onEvent: true, lastTriggeredAt, eventCooldownSec: 300 });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await service.trigger('review-draft', 'event');

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('event source fires when lastTriggeredAt is null (never triggered)', async () => {
      const cfg = makeConfig({ enabled: true, onEvent: true, lastTriggeredAt: null });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await service.trigger('review-draft', 'event');

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── no triggerUrl ─────────────────────────────────────────────────────────

  describe('trigger() with no triggerUrl', () => {
    it('records error and returns ok:false when no triggerUrl set', async () => {
      const cfg = makeConfig({ triggerUrl: null });
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      const result = await service.trigger('review-draft', 'manual');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no trigger url/i);
      expect(configSvc.recordTrigger).toHaveBeenCalledWith(
        'review-draft',
        'error',
        expect.stringMatching(/no trigger url/i),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── fire() HTTP behavior ──────────────────────────────────────────────────

  describe('fire() via trigger()', () => {
    it('calls fetch POST with Authorization header and JSON body', async () => {
      const cfg = makeConfig({ triggerUrl: 'https://claude.ai/api/trigger/abc' });
      const configSvc = makeConfigService(cfg, 'my-token');
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await service.trigger('review-draft', 'manual');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://claude.ai/api/trigger/abc',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ source: 'manual' }),
        }),
      );
    });

    it('records ok and returns ok:true on fetch success', async () => {
      const cfg = makeConfig();
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await service.trigger('review-draft', 'manual');

      expect(result.ok).toBe(true);
      expect(configSvc.recordTrigger).toHaveBeenCalledWith('review-draft', 'ok', undefined);
    });

    it('records error and returns ok:false on network throw', async () => {
      const cfg = makeConfig();
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await service.trigger('review-draft', 'manual');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      expect(configSvc.recordTrigger).toHaveBeenCalledWith(
        'review-draft',
        'error',
        expect.stringContaining('ECONNREFUSED'),
      );
    });

    it('records error and returns ok:false on non-2xx response', async () => {
      const cfg = makeConfig();
      const configSvc = makeConfigService(cfg);
      const service = new RoutineTriggerService(configSvc as any);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 502, text: jest.fn().mockResolvedValue('Bad Gateway') });

      const result = await service.trigger('review-draft', 'manual');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/502/);
      expect(configSvc.recordTrigger).toHaveBeenCalledWith(
        'review-draft',
        'error',
        expect.stringMatching(/502/),
      );
    });
  });
});
