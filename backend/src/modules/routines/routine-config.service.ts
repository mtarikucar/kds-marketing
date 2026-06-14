import { Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../common/crypto/secret-box.helper';
import type { RoutineConfig } from '@prisma/client';

/** All 4 cloud routine keys that must always exist in the DB. */
const ROUTINE_KEYS = [
  'review-draft',
  'content-pack',
  'insight-digest',
  'lead-scoring',
] as const;

export type RoutineKey = (typeof ROUTINE_KEYS)[number];

/** DTO for PATCH /platform/routines/:key */
export interface UpdateRoutineConfigDto {
  enabled?: boolean;
  cron?: string | null;
  onEvent?: boolean;
  triggerUrl?: string | null;
  /** Write-only. Never returned to callers. When present, sealed and stored. */
  triggerToken?: string;
  eventCooldownSec?: number;
}

/** Public shape returned by list() — triggerTokenSealed is omitted, hasToken added. */
export type RoutineConfigPublic = Omit<RoutineConfig, 'triggerTokenSealed'> & {
  hasToken: boolean;
};

/** Minimal interface to break the circular dependency at the type level. */
export interface IRoutineScheduleRunner {
  reload(key: string): Promise<void>;
}

@Injectable()
export class RoutineConfigService implements OnModuleInit {
  private readonly logger = new Logger(RoutineConfigService.name);
  /** Injected lazily to break the circular dep: RoutineConfigService ↔ RoutineScheduleRunner. */
  private scheduleRunner: IRoutineScheduleRunner | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Called by RoutinesModule after both providers are resolved. */
  setScheduleRunner(runner: IRoutineScheduleRunner): void {
    this.scheduleRunner = runner;
  }

  async onModuleInit(): Promise<void> {
    // Never let a boot-time DB hiccup crash the whole app — seed best-effort.
    try {
      await this.ensureSeeded();
    } catch (err) {
      this.logger.error(
        `RoutineConfig seed failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Upsert the 4 canonical routine rows so they always exist.
   * Only creates missing rows; does NOT toggle enabled on existing ones.
   */
  async ensureSeeded(): Promise<void> {
    await Promise.all(
      ROUTINE_KEYS.map((key) =>
        this.prisma.routineConfig.upsert({
          where: { key },
          create: { key, enabled: false },
          update: {}, // never clobber operator settings on restart
        }),
      ),
    );
    this.logger.log('RoutineConfig seed complete');
  }

  /**
   * Returns all 4 configs. Token is NEVER returned — callers get hasToken:boolean.
   */
  async list(): Promise<RoutineConfigPublic[]> {
    const rows = await this.prisma.routineConfig.findMany();
    return (rows ?? []).map((row) => this.toPublic(row));
  }

  /**
   * Returns the raw DB row (with triggerTokenSealed) for internal use.
   * Never expose this directly to callers.
   */
  async get(key: string): Promise<RoutineConfig | null> {
    return this.prisma.routineConfig.findUnique({ where: { key } });
  }

  /**
   * Update config fields for a given key. If triggerToken is provided:
   *   - Requires MARKETING_SECRET_KEY (503 if absent).
   *   - Seals the token and stores it in triggerTokenSealed.
   *   - triggerToken itself is never persisted.
   *
   * NOTE: scheduleRunner.reload(key) wired in backend-B
   */
  async update(key: string, dto: UpdateRoutineConfigDto): Promise<RoutineConfigPublic> {
    if (!(ROUTINE_KEYS as readonly string[]).includes(key)) {
      throw new NotFoundException('unknown routine key');
    }
    const { triggerToken, ...rest } = dto;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = { ...rest };

    if (triggerToken !== undefined) {
      if (!isSecretBoxConfigured()) {
        throw new ServiceUnavailableException(
          'MARKETING_SECRET_KEY is not configured — cannot seal the trigger token',
        );
      }
      data.triggerTokenSealed = sealSecret(triggerToken);
    }

    const updated = await this.prisma.routineConfig.update({
      where: { key },
      data,
    });

    // Keep the dynamic scheduler in sync whenever a config changes.
    if (this.scheduleRunner) {
      await this.scheduleRunner.reload(key);
    }

    return this.toPublic(updated);
  }

  /**
   * Stamp the last trigger outcome. Called by RoutineTriggerService after each attempt.
   */
  async recordTrigger(key: string, status: 'ok' | 'error', error?: string): Promise<void> {
    await this.prisma.routineConfig.update({
      where: { key },
      data: {
        lastTriggeredAt: new Date(),
        lastTriggerStatus: status,
        lastTriggerError: error ?? null,
      },
    });
  }

  /**
   * Decrypt the sealed token for internal use (e.g. by RoutineTriggerService).
   * Returns null if no token is stored or decryption fails.
   */
  resolveToken(config: RoutineConfig): string | null {
    if (!config.triggerTokenSealed) return null;
    try {
      return openSecret(config.triggerTokenSealed);
    } catch (err) {
      this.logger.error(`Failed to open sealed token for key=${config.key}: ${(err as Error).message}`);
      return null;
    }
  }

  // ── private ─────────────────────────────────────────────────────────────

  private toPublic(row: RoutineConfig): RoutineConfigPublic {
    // Destructure triggerTokenSealed out so it is never included in the result.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { triggerTokenSealed, ...rest } = row;
    return { ...rest, hasToken: triggerTokenSealed !== null };
  }
}
