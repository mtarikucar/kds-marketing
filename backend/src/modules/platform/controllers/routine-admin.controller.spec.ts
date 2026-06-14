/**
 * RoutineAdminController — plain-instantiation spec.
 *
 * Covers:
 *   - GET /platform/routines delegates to routineConfigService.list()
 *   - POST /platform/routines/:key/trigger delegates to routineTriggerService.trigger(key,'manual')
 *   - PATCH /platform/routines/:key with valid data delegates to routineConfigService.update()
 *   - PATCH rejects invalid cron with BadRequestException (400)
 *   - PATCH with no cron field skips cron validation
 *   - PATCH with null cron clears schedule (no cron error)
 */

import { BadRequestException } from '@nestjs/common';
import { RoutineAdminController } from './routine-admin.controller';
import { UpdateRoutineConfigDto } from '../dto/update-routine-config.dto';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeConfigService() {
  return {
    list: jest.fn().mockResolvedValue([
      {
        id: 'id-1',
        key: 'review-draft',
        enabled: true,
        cron: '0 * * * *',
        onEvent: false,
        triggerUrl: null,
        hasToken: false,
        eventCooldownSec: 300,
        lastTriggeredAt: null,
        lastTriggerStatus: null,
        lastTriggerError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]),
    update: jest.fn().mockResolvedValue({ key: 'review-draft', enabled: true }),
  };
}

function makeTriggerService() {
  return {
    trigger: jest.fn().mockResolvedValue({ ok: true }),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('RoutineAdminController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── GET /platform/routines ─────────────────────────────────────────────────

  describe('list()', () => {
    it('delegates to routineConfigService.list()', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const result = await controller.list();

      expect(configSvc.list).toHaveBeenCalledTimes(1);
      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'review-draft' })]));
    });
  });

  // ── POST /platform/routines/:key/trigger ───────────────────────────────────

  describe('triggerNow()', () => {
    it('delegates to routineTriggerService.trigger(key, manual)', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const result = await controller.triggerNow('review-draft');

      expect(triggerSvc.trigger).toHaveBeenCalledWith('review-draft', 'manual');
      expect(result).toEqual({ ok: true });
    });
  });

  // ── PATCH /platform/routines/:key ─────────────────────────────────────────

  describe('update()', () => {
    it('delegates to routineConfigService.update() for valid payload', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const dto: UpdateRoutineConfigDto = { enabled: true, cron: '0 * * * *' };
      const result = await controller.update('review-draft', dto);

      expect(configSvc.update).toHaveBeenCalledWith('review-draft', dto);
      expect(result).toEqual(expect.objectContaining({ key: 'review-draft' }));
    });

    it('throws BadRequestException for invalid cron expression', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const dto: UpdateRoutineConfigDto = { cron: 'not-a-valid-cron' };
      await expect(controller.update('review-draft', dto)).rejects.toThrow(BadRequestException);
      expect(configSvc.update).not.toHaveBeenCalled();
    });

    it('skips cron validation when cron is not in payload', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const dto: UpdateRoutineConfigDto = { enabled: false };
      await controller.update('review-draft', dto);

      expect(configSvc.update).toHaveBeenCalledWith('review-draft', dto);
    });

    it('skips cron validation when cron is null (clears schedule)', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const dto: UpdateRoutineConfigDto = { cron: null };
      await controller.update('review-draft', dto);

      expect(configSvc.update).toHaveBeenCalledWith('review-draft', dto);
    });

    it('throws BadRequestException for another invalid cron (extra fields)', async () => {
      const configSvc = makeConfigService();
      const triggerSvc = makeTriggerService();
      const controller = new RoutineAdminController(configSvc as any, triggerSvc as any);

      const dto: UpdateRoutineConfigDto = { cron: '99 99 99 99 99' };
      await expect(controller.update('review-draft', dto)).rejects.toThrow(BadRequestException);
    });
  });
});
