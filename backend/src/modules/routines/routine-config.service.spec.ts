/**
 * RoutineConfigService — plain-instantiation spec (no NestJS testing harness).
 *
 * Covers:
 *   - ensureSeeded() upserts every routine key
 *   - update() seals triggerToken via sealSecret
 *   - update() throws ServiceUnavailableException when MARKETING_SECRET_KEY unset
 *   - list() never returns triggerTokenSealed; sets hasToken correctly
 */

import { ServiceUnavailableException } from '@nestjs/common';
// ROUTINE_KEYS is imported, not copied. This file used to keep its own list and
// pinned a count of 4 against it; the moment the real list grew, the failure
// read as a puzzle rather than as a statement about seeding.
import { RoutineConfigService, ROUTINE_KEYS } from './routine-config.service';

// ── secret-box mock ──────────────────────────────────────────────────────────
// We mock the module so sealSecret/openSecret never touch the real crypto.
jest.mock('../../common/crypto/secret-box.helper', () => ({
  sealSecret: jest.fn((plain: string) => `sealed:${plain}`),
  openSecret: jest.fn((sealed: string) => sealed.replace('sealed:', '')),
  isSecretBoxConfigured: jest.fn(() => true),
}));

import {
  sealSecret,
  isSecretBoxConfigured,
} from '../../common/crypto/secret-box.helper';

// ── helpers ──────────────────────────────────────────────────────────────────
function makePrisma() {
  return {
    routineConfig: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeConfig(secretKeyPresent = true) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'MARKETING_SECRET_KEY') {
        return secretKeyPresent ? 'base64key==' : undefined;
      }
      return undefined;
    }),
  };
}

const makeBaseConfig = (key: string, overrides = {}) => ({
  id: `id-${key}`,
  key,
  enabled: false,
  cron: null,
  onEvent: false,
  triggerUrl: null,
  triggerTokenSealed: null,
  eventCooldownSec: 300,
  lastTriggeredAt: null,
  lastTriggerStatus: null,
  lastTriggerError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('RoutineConfigService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let config: ReturnType<typeof makeConfig>;
  let service: RoutineConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    config = makeConfig();
    service = new RoutineConfigService(prisma as any, config as any);
  });

  // ── ensureSeeded ─────────────────────────────────────────────────────────

  describe('ensureSeeded()', () => {
    it('upserts every routine key on module init', async () => {
      // Counted from ROUTINE_KEYS rather than pinned to a literal: the list has
      // grown once already (inbox-reply), and a hard 4 here would have failed
      // as a puzzle rather than as a statement about seeding.
      prisma.routineConfig.upsert.mockResolvedValue({});

      await service.ensureSeeded();

      expect(prisma.routineConfig.upsert).toHaveBeenCalledTimes(ROUTINE_KEYS.length);

      const calledKeys = prisma.routineConfig.upsert.mock.calls.map(
        (call: any) => call[0].where.key,
      );
      expect(calledKeys.sort()).toEqual(ROUTINE_KEYS.slice().sort());
    });

    it('upserts with enabled:false so existing rows are not toggled', async () => {
      prisma.routineConfig.upsert.mockResolvedValue({});

      await service.ensureSeeded();

      for (const call of prisma.routineConfig.upsert.mock.calls) {
        // create sets enabled:false; update only supplies the key (no override of enabled)
        expect(call[0].create.enabled).toBe(false);
      }
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns all configs without triggerTokenSealed', async () => {
      const rows = ROUTINE_KEYS.map((key) =>
        makeBaseConfig(key, { triggerTokenSealed: 'sealed:tok' }),
      );
      prisma.routineConfig.findMany.mockResolvedValue(rows);

      const result = await service.list();

      for (const item of result) {
        expect(item).not.toHaveProperty('triggerTokenSealed');
      }
    });

    it('sets hasToken:true when triggerTokenSealed is present', async () => {
      const rows = ROUTINE_KEYS.map((key) =>
        makeBaseConfig(key, { triggerTokenSealed: 'sealed:tok' }),
      );
      prisma.routineConfig.findMany.mockResolvedValue(rows);

      const result = await service.list();

      for (const item of result) {
        expect(item.hasToken).toBe(true);
      }
    });

    it('sets hasToken:false when triggerTokenSealed is null', async () => {
      const rows = ROUTINE_KEYS.map((key) => makeBaseConfig(key));
      prisma.routineConfig.findMany.mockResolvedValue(rows);

      const result = await service.list();

      for (const item of result) {
        expect(item.hasToken).toBe(false);
      }
    });

    it('returns [] (never throws) when findMany resolves undefined', async () => {
      // Regression: a stale/mocked client can yield undefined; list() must not
      // crash (this was crashing app boot via the scheduler's onModuleInit).
      prisma.routineConfig.findMany.mockResolvedValue(undefined as never);
      await expect(service.list()).resolves.toEqual([]);
    });
  });

  // ── get ──────────────────────────────────────────────────────────────────

  describe('get(key)', () => {
    it('returns the config for the given key', async () => {
      const row = makeBaseConfig('review-draft');
      prisma.routineConfig.findUnique.mockResolvedValue(row);

      const result = await service.get('review-draft');

      expect(result).toEqual(row);
      expect(prisma.routineConfig.findUnique).toHaveBeenCalledWith({
        where: { key: 'review-draft' },
      });
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update(key, dto)', () => {
    it('seals the triggerToken and stores it in triggerTokenSealed', async () => {
      const updated = makeBaseConfig('review-draft', {
        triggerTokenSealed: 'sealed:my-token',
      });
      prisma.routineConfig.update.mockResolvedValue(updated);

      await service.update('review-draft', { triggerToken: 'my-token' });

      expect(sealSecret).toHaveBeenCalledWith('my-token');
      const updateCall = prisma.routineConfig.update.mock.calls[0][0];
      expect(updateCall.data.triggerTokenSealed).toBe('sealed:my-token');
    });

    it('does not include triggerToken in the data written to prisma', async () => {
      prisma.routineConfig.update.mockResolvedValue(makeBaseConfig('review-draft'));

      await service.update('review-draft', { triggerToken: 'secret' });

      const updateCall = prisma.routineConfig.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('triggerToken');
    });

    it('throws ServiceUnavailableException when MARKETING_SECRET_KEY is unset', async () => {
      (isSecretBoxConfigured as jest.Mock).mockReturnValueOnce(false);

      await expect(
        service.update('review-draft', { triggerToken: 'tok' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(prisma.routineConfig.update).not.toHaveBeenCalled();
    });

    it('updates non-token fields without requiring MARKETING_SECRET_KEY', async () => {
      prisma.routineConfig.update.mockResolvedValue(
        makeBaseConfig('review-draft', { enabled: true }),
      );

      await service.update('review-draft', { enabled: true, cron: '0 * * * *' });

      const updateCall = prisma.routineConfig.update.mock.calls[0][0];
      expect(updateCall.data.enabled).toBe(true);
      expect(updateCall.data.cron).toBe('0 * * * *');
      // No seal call since no triggerToken in dto
      expect(sealSecret).not.toHaveBeenCalled();
    });

    it('persists eventCooldownSec when provided', async () => {
      prisma.routineConfig.update.mockResolvedValue(
        makeBaseConfig('review-draft', { eventCooldownSec: 60 }),
      );

      await service.update('review-draft', { eventCooldownSec: 60 });

      const updateCall = prisma.routineConfig.update.mock.calls[0][0];
      expect(updateCall.data.eventCooldownSec).toBe(60);
    });

    it('throws NotFoundException for unknown routine key', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      await expect(
        service.update('nonexistent-key', { enabled: true }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.routineConfig.update).not.toHaveBeenCalled();
    });
  });

  // ── recordTrigger ─────────────────────────────────────────────────────────

  describe('recordTrigger(key, status, error?)', () => {
    it('stamps lastTriggeredAt, lastTriggerStatus, and clears lastTriggerError on ok', async () => {
      prisma.routineConfig.update.mockResolvedValue(makeBaseConfig('review-draft'));

      await service.recordTrigger('review-draft', 'ok');

      const updateCall = prisma.routineConfig.update.mock.calls[0][0];
      expect(updateCall.data.lastTriggerStatus).toBe('ok');
      expect(updateCall.data.lastTriggeredAt).toBeInstanceOf(Date);
      expect(updateCall.data.lastTriggerError).toBeNull();
    });

    it('stamps error message on error status', async () => {
      prisma.routineConfig.update.mockResolvedValue(makeBaseConfig('review-draft'));

      await service.recordTrigger('review-draft', 'error', 'timeout');

      const updateCall = prisma.routineConfig.update.mock.calls[0][0];
      expect(updateCall.data.lastTriggerStatus).toBe('error');
      expect(updateCall.data.lastTriggerError).toBe('timeout');
    });
  });

  describe('inbox-reply — the key that is not a nightly routine', () => {
    it('is seeded with a much shorter cooldown than the scheduled ones', async () => {
      // The four nightly routines are compared against the morning they exist
      // to protect. This one is compared against how long a customer who just
      // wrote in will sit there.
      prisma.routineConfig.upsert.mockResolvedValue({});
      await service.ensureSeeded();
      const inbox = prisma.routineConfig.upsert.mock.calls.find(
        (c: any) => c[0].where.key === 'inbox-reply',
      );
      expect(inbox[0].create.eventCooldownSec).toBe(30);
    });

    it('leaves the scheduled routines on the platform default', async () => {
      prisma.routineConfig.upsert.mockResolvedValue({});
      await service.ensureSeeded();
      const nightly = prisma.routineConfig.upsert.mock.calls.find(
        (c: any) => c[0].where.key === 'lead-scoring',
      );
      expect(nightly[0].create).not.toHaveProperty('eventCooldownSec');
    });

    it('still never clobbers an operator setting on restart', async () => {
      prisma.routineConfig.upsert.mockResolvedValue({});
      await service.ensureSeeded();
      for (const call of prisma.routineConfig.upsert.mock.calls) {
        expect(call[0].update).toEqual({});
      }
    });
  });
});
