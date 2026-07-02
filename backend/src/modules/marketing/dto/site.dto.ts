import {
  IsString, IsNotEmpty, IsOptional, IsArray, IsObject, IsBoolean, IsInt, IsIn, Min, Max, MaxLength,
  ValidateNested, ArrayMaxSize, IsISO8601, IsEmail,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSitePageDto {
  @IsString() @IsNotEmpty() @MaxLength(120) title: string;
  @IsOptional() @IsString() @MaxLength(80) slug?: string;
  @IsOptional() @IsArray() blocks?: unknown[];
  @IsOptional() @IsObject() seo?: Record<string, unknown>;
  @IsOptional() @IsObject() theme?: Record<string, unknown>;
}
export class UpdateSitePageDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(80) slug?: string;
  @IsOptional() @IsArray() blocks?: unknown[];
  @IsOptional() @IsObject() seo?: Record<string, unknown>;
  @IsOptional() @IsObject() theme?: Record<string, unknown>;
  @IsOptional() @IsBoolean() published?: boolean;
}
export class DraftSiteDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) prompt: string;
}
export class CreateFormDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsArray() fields?: unknown[];
  @IsOptional() @IsString() @MaxLength(2000) redirectUrl?: string;
}
export class UpdateFormDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsArray() fields?: unknown[];
  @IsOptional() @IsString() @MaxLength(2000) redirectUrl?: string;
}
export class CreateCalendarDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(64) ownerUserId?: string;
  /** GHL calendar type — defaults SINGLE. */
  @IsOptional() @IsString() @IsIn(['SINGLE', 'ROUND_ROBIN', 'COLLECTIVE', 'CLASS']) type?: string;
  /** Attendees per slot for a CLASS calendar (ignored for other types). */
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
  @IsOptional() @IsObject() availability?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(5) @Max(480) slotMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) bufferMinutes?: number;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  /** Video-conferencing provider attached to this calendar's bookings. */
  @IsOptional() @IsString() @IsIn(['NONE', 'GOOGLE_MEET', 'TEAMS']) conferencing?: string;
  // Booking policy (Phase 2).
  @IsOptional() @IsInt() @Min(0) @Max(43200) minNoticeMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) maxAdvanceDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) bufferBeforeMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) bufferAfterMinutes?: number;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  /** Array of { offsetMinutes, channels:['EMAIL'|'SMS'], audience:'CUSTOMER'|'HOST'|'BOTH' }. */
  @IsOptional() @IsArray() reminderConfig?: unknown[];
}
export class UpdateCalendarDto extends CreateCalendarDto {
  @IsOptional() declare name: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** A team member for a ROUND_ROBIN / COLLECTIVE calendar. */
export class CalendarMemberDto {
  @IsString() @IsNotEmpty() @MaxLength(64) marketingUserId: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) priority?: number;
}

/** Create a blackout / time-off window. */
export class CreateBlackoutDto {
  @IsOptional() @IsString() @MaxLength(64) calendarId?: string;
  @IsOptional() @IsString() @MaxLength(64) marketingUserId?: string;
  @IsString() @IsNotEmpty() @MaxLength(40) startAt: string;
  @IsString() @IsNotEmpty() @MaxLength(40) endAt: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

/** Upsert a member's working hours for a calendar. */
export class SetMemberAvailabilityDto {
  @IsString() @IsNotEmpty() @MaxLength(64) marketingUserId: string;
  @IsObject() availability: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

/** Query filter for the admin bookings list. */
export class ListBookingsQueryDto {
  @IsOptional() @IsString() @MaxLength(64) calendarId?: string;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
  @IsOptional() @IsString() @MaxLength(40) from?: string;
  @IsOptional() @IsString() @MaxLength(40) to?: string;
}

/** Move a booking to a new start time (ISO datetime). */
export class RescheduleBookingDto {
  @IsString() @IsNotEmpty() start: string;
}

/** Staff-created (in-app) booking. Runs the same BookingService.book() validation
 *  as the public reserve path (future / min-notice / max-advance / grid-aligned). */
export class AdminBookDto {
  @IsString() @IsNotEmpty() @MaxLength(60) calendarId: string;
  @IsISO8601() @MaxLength(40) start: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @MaxLength(64) attendeeTimezone?: string;
}

/** Admin status transition for a booking. */
export class SetBookingStatusDto {
  @IsString() @IsIn(['CONFIRMED', 'NO_SHOW', 'COMPLETED', 'CANCELLED']) status: string;
}

/** Replace a calendar's full member set. */
export class SetCalendarMembersDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CalendarMemberDto)
  members: CalendarMemberDto[];
}

export class FromTemplateDto {
  @IsString() @IsNotEmpty() @MaxLength(64) templateId: string;
}
