import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  DEVICE_MODES,
  DEVICE_STATUSES,
  describeDeviceCommand,
  validateDeviceCommand,
} from './device-commands';

/** How long a queued command stays worth running.
 *
 *  A phone plugged back in after a week must not replay a day of taps at once:
 *  a device command is an instruction about a screen that existed when it was
 *  written, and that screen is gone. */
const COMMAND_TTL_MS = Number(process.env.DEVICE_COMMAND_TTL_MS ?? 10 * 60 * 1000);

/** A claim the bridge never completed — it crashed, the cable came out, the
 *  laptop slept. Returned to the queue rather than left CLAIMED forever. */
const CLAIM_STALE_MS = Number(process.env.DEVICE_CLAIM_STALE_MS ?? 2 * 60 * 1000);

/** One command at a time, per device.
 *
 *  Not a throughput limit — a correctness one. A phone has ONE screen, and two
 *  commands in flight against it are two instructions written for states that
 *  cannot both still be true. The bridge asks for the next only after it has
 *  reported the last. */
const CLAIM_BATCH = 1;

export interface EnqueueOptions {
  source: string;
  requestedBy?: string;
}

/**
 * Device control — a workspace driving a physical phone.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE. The server is in a datacentre and the
 * phone is on somebody's desk with a cable in it. There is no route from one to
 * the other, and there never will be. So nothing here sends anything: commands
 * are QUEUED, a local bridge authenticated as the workspace CLAIMS them, and
 * the result is written back. Every method below is one half of that
 * rendezvous.
 *
 * The consequence worth stating: a command that is queued has not happened. It
 * may never happen — the laptop is closed, the person said no, the phone is in
 * a pocket. Callers that need a thing to be true must read the outcome, not
 * assume the enqueue.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── the workspace side ────────────────────────────────────────────────────

  list(workspaceId: string) {
    return this.prisma.device.findMany({
      where: { workspaceId, status: { not: 'REVOKED' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    workspaceId: string,
    dto: { label: string; mode?: string; serial?: string },
    createdById?: string,
  ) {
    const mode = dto.mode ?? 'MANUAL';
    if (!(DEVICE_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`mode must be one of: ${DEVICE_MODES.join(', ')}`);
    }
    return this.prisma.device.create({
      data: {
        workspaceId,
        label: dto.label.trim().slice(0, 120),
        serial: dto.serial?.trim() || null,
        mode,
        createdById: createdById ?? null,
      },
    });
  }

  async setMode(workspaceId: string, deviceId: string, mode: string) {
    if (!(DEVICE_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`mode must be one of: ${DEVICE_MODES.join(', ')}`);
    }
    await this.require(workspaceId, deviceId);
    return this.prisma.device.update({ where: { id: deviceId }, data: { mode } });
  }

  /**
   * Pause or revoke — the stop button.
   *
   * Pausing also EMPTIES the queue. Leaving commands behind would mean that
   * resuming a device replays whatever was waiting when it was stopped, which
   * is the opposite of what someone reaching for a stop button wants.
   */
  async setStatus(workspaceId: string, deviceId: string, status: string) {
    if (!(DEVICE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of: ${DEVICE_STATUSES.join(', ')}`);
    }
    await this.require(workspaceId, deviceId);
    const [device] = await this.prisma.$transaction([
      this.prisma.device.update({ where: { id: deviceId }, data: { status } }),
      ...(status === 'ACTIVE'
        ? []
        : [
            this.prisma.deviceCommand.updateMany({
              where: { deviceId, workspaceId, status: { in: ['QUEUED', 'CLAIMED'] } },
              data: { status: 'EXPIRED', completedAt: new Date(), error: `device ${status.toLowerCase()}` },
            }),
          ]),
    ]);
    return device;
  }

  /**
   * Queue a command.
   *
   * Refuses rather than queues when the device cannot act, and the distinction
   * matters: a caller told "queued" reasonably believes something will happen.
   */
  async enqueue(
    workspaceId: string,
    deviceId: string,
    kind: string,
    rawArgs: unknown,
    opts: EnqueueOptions,
  ) {
    const device = await this.require(workspaceId, deviceId);
    if (device.status !== 'ACTIVE') {
      throw new BadRequestException(
        `"${device.label}" is ${device.status.toLowerCase()} — resume it before sending it anything`,
      );
    }
    const args = validateDeviceCommand(kind, rawArgs);
    return this.prisma.deviceCommand.create({
      data: {
        deviceId,
        workspaceId,
        kind,
        args: args as never,
        source: opts.source,
        requestedBy: opts.requestedBy ?? null,
        expiresAt: new Date(Date.now() + COMMAND_TTL_MS),
      },
    });
  }

  history(workspaceId: string, deviceId: string, take = 50) {
    return this.prisma.deviceCommand.findMany({
      where: { workspaceId, deviceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
    });
  }

  // ── the bridge side ───────────────────────────────────────────────────────

  /**
   * The bridge announcing itself: which handset is on the other end of the
   * cable, and that it is still there.
   *
   * `properties` is whatever the bridge observed — model, Android version,
   * screen size. It is stored unmerged rather than deep-merged: a fresh report
   * is the truth about a device that may have been swapped for another one.
   */
  async heartbeat(workspaceId: string, deviceId: string, properties?: Record<string, unknown>) {
    const device = await this.require(workspaceId, deviceId);
    return this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        pairedAt: device.pairedAt ?? new Date(),
        ...(properties ? { properties: properties as never } : {}),
      },
    });
  }

  /**
   * Hand the bridge the next command, atomically.
   *
   * The claim is a conditional write narrowed by `status: 'QUEUED'`, not a read
   * followed by an update: two bridges polling the same device — a laptop left
   * running at the office and another at home — must not both run the same tap.
   * The loser sees `count: 0` and asks again.
   */
  async claimNext(workspaceId: string, deviceId: string) {
    const device = await this.require(workspaceId, deviceId);
    if (device.status !== 'ACTIVE') return null;

    await this.releaseStaleClaims(workspaceId, deviceId);
    await this.expireOverdue(workspaceId, deviceId);

    const candidates = await this.prisma.deviceCommand.findMany({
      where: { deviceId, workspaceId, status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: CLAIM_BATCH + 4,
    });

    for (const candidate of candidates) {
      const claimed = await this.prisma.deviceCommand.updateMany({
        // Scoped even though `candidate` came from a workspace-scoped read:
        // the narrowing costs nothing and it means this write is safe to read
        // in isolation, which is how it will be read.
        where: { id: candidate.id, workspaceId, status: 'QUEUED' },
        data: { status: 'CLAIMED', claimedAt: new Date() },
      });
      if (claimed.count === 0) continue; // somebody else took it
      return {
        ...candidate,
        status: 'CLAIMED',
        // The sentence the bridge shows the person whose thumb approves it.
        // Built here so what the server queued and what the human was asked
        // cannot drift apart.
        description: describeDeviceCommand(candidate.kind, candidate.args as Record<string, unknown>),
        requiresApproval: device.mode === 'MANUAL',
      };
    }
    return null;
  }

  /**
   * The bridge reporting back.
   *
   * REFUSED is its own outcome and deliberately not an error: a person
   * declining a command is the manual mode working, and folding it into FAILED
   * would make the one signal that proves a human was in the loop look like a
   * malfunction.
   */
  async complete(
    workspaceId: string,
    commandId: string,
    outcome: {
      status: 'DONE' | 'FAILED' | 'REFUSED';
      result?: Record<string, unknown>;
      error?: string;
      screenshotKey?: string;
    },
  ) {
    const done = await this.prisma.deviceCommand.updateMany({
      where: { id: commandId, workspaceId, status: 'CLAIMED' },
      data: {
        status: outcome.status,
        result: (outcome.result ?? null) as never,
        error: outcome.error?.slice(0, 1000) ?? null,
        screenshotKey: outcome.screenshotKey ?? null,
        completedAt: new Date(),
      },
    });
    if (done.count === 0) {
      // Not found, not ours, or already reported. A bridge retrying after a
      // network blip must not be able to overwrite a settled outcome.
      throw new NotFoundException('no claimed command with that id');
    }
    return this.prisma.deviceCommand.findFirst({ where: { id: commandId, workspaceId } });
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  /** A claim whose bridge went away. Back to QUEUED so the next poll gets it. */
  private releaseStaleClaims(workspaceId: string, deviceId: string) {
    return this.prisma.deviceCommand.updateMany({
      where: {
        workspaceId,
        deviceId,
        status: 'CLAIMED',
        claimedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) },
      },
      data: { status: 'QUEUED', claimedAt: null },
    });
  }

  private expireOverdue(workspaceId: string, deviceId: string) {
    return this.prisma.deviceCommand.updateMany({
      where: { workspaceId, deviceId, status: 'QUEUED', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED', completedAt: new Date(), error: 'nobody collected this in time' },
    });
  }

  private async require(workspaceId: string, deviceId: string) {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, workspaceId } });
    if (!device) throw new NotFoundException('device not found');
    return device;
  }
}
