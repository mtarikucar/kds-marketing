import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { CoursesService } from './courses.service';
import {
  CreateCourseDto,
  LessonDto,
  ModuleDto,
  ReorderDto,
  UpdateCourseDto,
} from './course.dto';

// Course/module/lesson authoring + publish — MANAGER+ (learners consume courses
// via enrollment/public routes, never this authoring surface). Closes the no-op
// MarketingRolesGuard gap.
@MarketingRoute()
@Controller('marketing/courses')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class CoursesController {
  constructor(private readonly svc: CoursesService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'course.create', resourceType: 'course' })
  create(@Body() dto: CreateCourseDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  // --- module/lesson routes (literal-prefixed, declared before :id) ---

  @Patch('modules/:moduleId')
  @Audit({ action: 'course.module.update', resourceType: 'course-module', resourceIdParam: 'moduleId' })
  updateModule(
    @Param('moduleId') moduleId: string,
    @Body() dto: ModuleDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.updateModule(u.workspaceId, moduleId, dto.title);
  }

  @Delete('modules/:moduleId')
  @Audit({ action: 'course.module.delete', resourceType: 'course-module', resourceIdParam: 'moduleId' })
  removeModule(@Param('moduleId') moduleId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.removeModule(u.workspaceId, moduleId);
  }

  @Post('modules/:moduleId/lessons')
  @Audit({ action: 'course.lesson.add', resourceType: 'course-module', resourceIdParam: 'moduleId' })
  addLesson(
    @Param('moduleId') moduleId: string,
    @Body() dto: LessonDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.addLesson(u.workspaceId, moduleId, dto);
  }

  @Patch('lessons/:lessonId')
  @Audit({ action: 'course.lesson.update', resourceType: 'lesson', resourceIdParam: 'lessonId' })
  updateLesson(
    @Param('lessonId') lessonId: string,
    @Body() dto: LessonDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.updateLesson(u.workspaceId, lessonId, dto);
  }

  @Delete('lessons/:lessonId')
  @Audit({ action: 'course.lesson.delete', resourceType: 'lesson', resourceIdParam: 'lessonId' })
  removeLesson(@Param('lessonId') lessonId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.removeLesson(u.workspaceId, lessonId);
  }

  // --- course :id routes ---

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'course.update', resourceType: 'course', resourceIdParam: 'id' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'course.delete', resourceType: 'course', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }

  @Post(':id/publish')
  @Audit({ action: 'course.publish', resourceType: 'course', resourceIdParam: 'id' })
  publish(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.publish(u.workspaceId, id);
  }

  @Post(':id/modules')
  @Audit({ action: 'course.module.add', resourceType: 'course', resourceIdParam: 'id' })
  addModule(
    @Param('id') id: string,
    @Body() dto: ModuleDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.addModule(u.workspaceId, id, dto.title);
  }

  @Post(':id/modules/reorder')
  @Audit({ action: 'course.module.reorder', resourceType: 'course', resourceIdParam: 'id' })
  reorderModules(
    @Param('id') id: string,
    @Body() dto: ReorderDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.reorderModules(u.workspaceId, id, dto.ids);
  }
}
