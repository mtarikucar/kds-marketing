import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { BookingService } from '../sites/booking.service';
import {
  CreateCalendarDto,
  UpdateCalendarDto,
  SetCalendarMembersDto,
  RescheduleBookingDto,
  SetBookingStatusDto,
  CreateBlackoutDto,
  SetMemberAvailabilityDto,
  ListBookingsQueryDto,
} from '../dto/site.dto';

/** Booking calendars (config). MANAGER+ behind `funnels`. Public booking is separate. */
@MarketingRoute()
@Controller('marketing/calendars')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('funnels')
export class MarketingBookingController {
  constructor(private readonly booking: BookingService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) { return this.booking.list(a.workspaceId); }

  // Static GET routes declared BEFORE `:id` so they aren't captured by it.
  /** Blackout / time-off windows (workspace-wide + optionally one calendar). */
  @Get('blackouts')
  listBlackouts(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Query('calendarId') calendarId?: string,
  ) {
    return this.booking.listBlackouts(a.workspaceId, calendarId);
  }

  /** Real appointments for the in-app list (excludes external busy blocks). */
  @Get('bookings')
  listBookings(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Query() q: ListBookingsQueryDto,
  ) {
    return this.booking.listBookings(a.workspaceId, q);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateCalendarDto) { return this.booking.create(a.workspaceId, dto); }

  @Get(':id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.booking.get(a.workspaceId, id); }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateCalendarDto) { return this.booking.update(a.workspaceId, id, dto); }

  @Delete(':id')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.booking.remove(a.workspaceId, id); }

  /** Team members for a ROUND_ROBIN / COLLECTIVE calendar. */
  @Get(':id/members')
  listMembers(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.booking.listMembers(a.workspaceId, id);
  }

  @Post(':id/members')
  @RequirePermission('settings.manage')
  setMembers(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: SetCalendarMembersDto,
  ) {
    return this.booking.setMembers(a.workspaceId, id, dto.members);
  }

  /**
   * Cancel a single BOOKING (not a calendar) — marks it CANCELLED and deletes
   * its mirrored Google Calendar event. Distinct path so it never collides with
   * the calendar `:id` routes above.
   */
  @Post('bookings/:bookingId/cancel')
  @RequirePermission('settings.manage')
  cancelBooking(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('bookingId') bookingId: string,
  ) {
    return this.booking.cancel(a.workspaceId, bookingId);
  }

  /** Move a booking to a new time (in place; moves the Meet/Teams meeting too). */
  @Post('bookings/:bookingId/reschedule')
  @RequirePermission('settings.manage')
  rescheduleBooking(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('bookingId') bookingId: string,
    @Body() dto: RescheduleBookingDto,
  ) {
    return this.booking.reschedule(a.workspaceId, bookingId, dto.start);
  }

  /** Approve a pending booking or mark it no-show / completed / cancelled. */
  @Patch('bookings/:bookingId/status')
  @RequirePermission('settings.manage')
  setBookingStatus(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('bookingId') bookingId: string,
    @Body() dto: SetBookingStatusDto,
  ) {
    return this.booking.setStatus(a.workspaceId, bookingId, dto.status);
  }

  @Post('blackouts')
  @RequirePermission('settings.manage')
  createBlackout(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateBlackoutDto) {
    return this.booking.createBlackout(a.workspaceId, dto);
  }

  @Delete('blackouts/:id')
  @RequirePermission('settings.manage')
  deleteBlackout(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.booking.deleteBlackout(a.workspaceId, id);
  }

  /** A calendar's per-member working hours (Phase 2). */
  @Get(':id/member-availability')
  listMemberAvailability(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.booking.listMemberAvailability(a.workspaceId, id);
  }

  @Post(':id/member-availability')
  @RequirePermission('settings.manage')
  setMemberAvailability(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: SetMemberAvailabilityDto,
  ) {
    return this.booking.setMemberAvailability(a.workspaceId, id, dto.marketingUserId, dto.availability, dto.timezone);
  }
}
