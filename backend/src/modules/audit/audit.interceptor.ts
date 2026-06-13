import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { Request } from 'express';
import { AUDIT_METADATA, AuditOptions } from './audit.decorator';
import { AuditLogService, AuditActorType } from './audit-log.service';

/**
 * Turns an `@Audit(...)`-marked handler into an append-only audit row (backlog #3).
 *
 * Resolves the actor across the three auth realms (platform operator, marketing
 * user, internal service) by inspecting where each guard stashed its principal,
 * pulls the resource id from the route params, the correlation id + client ip
 * off the request, and records SUCCESS on completion or FAILURE if the handler
 * throws — without swallowing the original error. Handlers without the decorator
 * pass straight through untouched.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditOptions | undefined>(
      AUDIT_METADATA,
      context.getHandler(),
    );
    if (!options || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<AuditableRequest>();
    const base = this.baseEntry(req, options);

    return next.handle().pipe(
      tap({
        next: () => void this.audit.record({ ...base, outcome: 'SUCCESS' }),
        error: () => void this.audit.record({ ...base, outcome: 'FAILURE' }),
      }),
    );
  }

  private baseEntry(req: AuditableRequest, options: AuditOptions) {
    const actor = this.resolveActor(req);
    const resourceId = options.resourceIdParam
      ? (req.params?.[options.resourceIdParam] ?? null)
      : null;

    let metadata: Record<string, unknown> | null = null;
    if (options.captureBody?.length && req.body) {
      metadata = {};
      for (const key of options.captureBody) {
        if (req.body[key] !== undefined) metadata[key] = req.body[key];
      }
      if (Object.keys(metadata).length === 0) metadata = null;
    }

    return {
      action: options.action,
      resourceType: options.resourceType,
      resourceId,
      ...actor,
      requestId: req.id ?? null,
      ip: req.ip ?? null,
      metadata,
    };
  }

  private resolveActor(req: AuditableRequest): {
    actorType: AuditActorType;
    actorId: string | null;
    actorEmail: string | null;
    workspaceId: string | null;
  } {
    if (req.platformOperator) {
      return {
        actorType: 'PLATFORM_OPERATOR',
        actorId: req.platformOperator.id ?? null,
        actorEmail: req.platformOperator.email ?? null,
        workspaceId: null, // platform realm acts cross-workspace
      };
    }
    if (req.marketingUser) {
      return {
        actorType: 'MARKETING_USER',
        actorId: req.marketingUser.id ?? null,
        actorEmail: req.marketingUser.email ?? null,
        workspaceId: req.marketingUser.workspaceId ?? null,
      };
    }
    if (req.ingestWorkspaceId) {
      return {
        actorType: 'SERVICE',
        actorId: null,
        actorEmail: null,
        workspaceId: req.ingestWorkspaceId,
      };
    }
    return {
      actorType: 'SYSTEM',
      actorId: null,
      actorEmail: null,
      workspaceId: null,
    };
  }
}

interface AuditableRequest extends Request {
  id?: string;
  platformOperator?: { id?: string; email?: string };
  marketingUser?: { id?: string; email?: string; workspaceId?: string };
  ingestWorkspaceId?: string;
}
