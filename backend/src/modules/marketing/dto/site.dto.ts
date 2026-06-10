import {
  IsString, IsNotEmpty, IsOptional, IsArray, IsObject, IsBoolean, IsInt, Min, Max, MaxLength,
} from 'class-validator';

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
  @IsOptional() @IsObject() availability?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(5) @Max(480) slotMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) bufferMinutes?: number;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}
export class UpdateCalendarDto extends CreateCalendarDto {
  @IsOptional() declare name: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
