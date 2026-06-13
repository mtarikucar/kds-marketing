import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type AuditActorType =
  | 'PLATFORM_OPERATOR'
  | 'MARKETING_USER'
  | 'SERVICE'
  | 'SYSTEM';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE';
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes the append-only audit trail (backlog #3).
 *
 * Two invariants:
 *   1. APPEND-ONLY — this service exposes only `record()`. There is no update or
 *      delete path, so the trail is tamper-evident at the application layer.
 *   2. NON-FATAL — auditing must never break the action it observes. `record()`
 *      swallows and logs its own failures; a DB hiccup writing the audit row
 *      will not 500 the user's request. (The write is also deliberately outside
 *      any business transaction — see the model doc.)
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          workspaceId: entry.workspaceId ?? null,
          requestId: entry.requestId ?? null,
          ip: entry.ip ?? null,
          outcome: entry.outcome ?? 'SUCCESS',
          // Cast at the persistence boundary: the entry carries a plain record
          // (so callers/interceptor stay Prisma-free); null collapses to the
          // JSON-null sentinel the column expects.
          metadata:
            entry.metadata == null
              ? Prisma.JsonNull
              : (entry.metadata as Prisma.InputJsonValue),
        },
      });
    } catch (err) {
      // Last-resort: never let an audit failure surface to the caller. The
      // correlation id ties this back to the originating request's logs.
      this.logger.error(
        `Failed to write audit log for ${entry.action} on ${entry.resourceType}:${entry.resourceId ?? '-'}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
