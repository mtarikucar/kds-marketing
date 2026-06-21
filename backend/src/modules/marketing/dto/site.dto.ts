import {
  IsString, IsNotEmpty, IsOptional, IsArray, IsObject, IsBoolean, IsInt, IsIn, Min, Max, MaxLength,
  ValidateNested, ArrayMaxSize,
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

/** Replace a calendar's full member set. */
export class SetCalendarMembersDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CalendarMemberDto)
  members: CalendarMemberDto[];
}
