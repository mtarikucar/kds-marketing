import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
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
import { CreateCalendarDto, UpdateCalendarDto } from '../dto/site.dto';

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
}
