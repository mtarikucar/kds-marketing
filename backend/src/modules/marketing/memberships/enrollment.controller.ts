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
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { EnrollmentService } from './enrollment.service';
import { CompleteLessonDto, EnrollDto } from './enrollment.dto';

@MarketingRoute()
@Controller('marketing/enrollments')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class EnrollmentController {
  constructor(private readonly svc: EnrollmentService) {}

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

  @Delete(':id')
  @Audit({ action: 'enrollment.delete', resourceType: 'enrollment', resourceIdParam: 'id' })
  unenroll(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.unenroll(u.workspaceId, id);
  }
}
