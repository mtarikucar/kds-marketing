import { IsString, IsNotEmpty, IsOptional, IsEmail, IsISO8601, MaxLength } from 'class-validator';

/**
 * Public, untrusted funnel DTOs (no auth). Validated + length-capped at the
 * controller edge so a forged booking/slots request can't carry oversize or
 * malformed input into the booking service.
 */
export class BookSlotDto {
  @IsISO8601() @MaxLength(40) start: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  /** Attendee's IANA timezone, captured for customer-facing times. */
  @IsOptional() @IsString() @MaxLength(64) attendeeTimezone?: string;
}

export class SlotsQueryDto {
  @IsOptional() @IsISO8601() @MaxLength(40) from?: string;
  @IsOptional() @IsISO8601() @MaxLength(40) to?: string;
}

/** Public self-service reschedule of a booking by its token. */
export class RescheduleTokenDto {
  @IsISO8601() @MaxLength(40) start: string;
}
