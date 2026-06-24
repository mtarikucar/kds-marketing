import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { EnrollmentService } from './enrollment.service';
import { CertificateService } from './certificate.service';
import { CompleteLessonDto, EnrollDto } from './enrollment.dto';

@MarketingRoute()
@Controller('marketing/enrollments')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class EnrollmentController {
  constructor(
    private readonly svc: EnrollmentService,
    private readonly certificates: CertificateService,
  ) {}

  @Get()
  list(
    @Query('courseId') courseId: string,
    @Query('leadId') leadId: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.list(u.workspaceId, { courseId, leadId });
  }

  @Post()
  @Audit({ action: 'enrollment.create', resourceType: 'enrollment' })
  enroll(@Body() dto: EnrollDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.enroll(u.workspaceId, dto.courseId, dto.leadId);
  }

  @Get(':id')
  progress(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.getProgress(u.workspaceId, id);
  }

  @Post(':id/complete-lesson')
  @Audit({ action: 'enrollment.lesson.complete', resourceType: 'enrollment', resourceIdParam: 'id' })
  completeLesson(
    @Param('id') id: string,
    @Body() dto: CompleteLessonDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.markLessonComplete(u.workspaceId, id, dto.lessonId);
  }

  /** The completion certificate for this enrollment (null until it's earned). */
  @Get(':id/certificate')
  certificate(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.certificates.getForEnrollment(u.workspaceId, id);
  }

  // Destructive (drops the enrollment + its progress) — MANAGER+. enroll +
  // complete-lesson above stay open as day-to-day rep actions on a lead.
  @Delete(':id')
  @MarketingRoles('MANAGER')
  @Audit({ action: 'enrollment.delete', resourceType: 'enrollment', resourceIdParam: 'id' })
  unenroll(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.unenroll(u.workspaceId, id);
  }
}
