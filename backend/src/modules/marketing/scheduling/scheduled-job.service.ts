import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ScheduleOpts {
  workspaceId: string;
  kind: string;
  runAt: Date;
  payload: Prisma.InputJsonValue;
  /** When set, rescheduling collapses onto the existing PENDING row. */
  dedupKey?: string;
  maxAttempts?: number;
}

type Tx = Prisma.TransactionClient | PrismaService;

/**
 * Enqueue/cancel side of the delayed-work primitive. The runner
 * (scheduled-job-runner.service) claims + dispatches. See the model comment
 * for why this is separate from OutboxEvent.
 */
@Injectable()
export class ScheduledJobService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Schedule a job. With a dedupKey, an existing PENDING job of the same
   * (kind, dedupKey) is updated in place (runAt/payload) rather than
   * duplicated — so "reschedule the follow-up" is one row, not a pile-up.
   * The partial-unique index is the backstop against a concurrent racer.
   */
  async schedule(opts: ScheduleOpts, tx: Tx = this.prisma): Promise<string> {
    const db = tx as PrismaService;
    if (opts.dedupKey) {
      const existing = await db.scheduledJob.findFirst({
        where: { kind: opts.kind, dedupKey: opts.dedupKey, status: 'PENDING' },
        select: { id: true },
      });
      if (existing) {
        await db.scheduledJob.update({
          where: { id: existing.id },
          data: {
            runAt: opts.runAt,
            payload: opts.payload,
            workspaceId: opts.workspaceId,
            ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
          },
        });
        return existing.id;
      }
    }
    try {
      const job = await db.scheduledJob.create({
        data: {
          workspaceId: opts.workspaceId,
          kind: opts.kind,
          runAt: opts.runAt,
          payload: opts.payload,
          dedupKey: opts.dedupKey ?? null,
          maxAttempts: opts.maxAttempts ?? 5,
        },
        select: { id: true },
      });
      return job.id;
    } catch (e) {
      // Lost a race with a concurrent scheduler for the same (kind, dedupKey):
      // the partial-unique index rejected this create. Collapse onto the winner's
      // PENDING row (same semantic as the findFirst path above) rather than
      // surfacing the raw P2002 as a 500.
      if (
        opts.dedupKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await db.scheduledJob.findFirst({
          where: { kind: opts.kind, dedupKey: opts.dedupKey, status: 'PENDING' },
          select: { id: true },
        });
        if (winner) return winner.id;
      }
      throw e;
    }
  }

  /** Cancel the PENDING job for (kind, dedupKey). Returns true if one was cancelled. */
  async cancel(kind: string, dedupKey: string, tx: Tx = this.prisma): Promise<boolean> {
    const db = tx as PrismaService;
    const res = await db.scheduledJob.updateMany({
      where: { kind, dedupKey, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    return res.count > 0;
  }

  async cancelById(id: string): Promise<boolean> {
    const res = await this.prisma.scheduledJob.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    return res.count > 0;
  }
}
