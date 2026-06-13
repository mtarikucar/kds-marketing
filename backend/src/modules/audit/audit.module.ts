import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';

/**
 * Append-only audit trail (backlog #3).
 *
 * @Global so any service can inject {@link AuditLogService} to record an audit
 * event imperatively, while the global {@link AuditInterceptor} handles the
 * common declarative case for any handler tagged with `@Audit(...)`.
 */
@Global()
@Module({
  providers: [
    AuditLogService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditLogService],
})
export class AuditModule {}
