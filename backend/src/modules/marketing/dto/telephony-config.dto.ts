import { IsOptional, IsString, IsObject, IsIn, IsBoolean, IsInt, Min, MaxLength, ValidateIf, Matches } from 'class-validator';

export class UpsertTelephonyConfigDto {
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(20) trunk?: string;
  @IsOptional() @IsString() @MaxLength(20) pbxnum?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
  @IsOptional() @IsString() @MaxLength(255) @Matches(/^wss:\/\//i, { message: 'wssUrl must be a wss:// URL' }) wssUrl?: string;
  @IsOptional() @IsString() @MaxLength(120) sipDomain?: string;
  /** Call-recording toggle (KVKK requires a caller announcement — surfaced by the frontend, not enforced here). */
  @IsOptional() @IsBoolean() recordCalls?: boolean;
  /** Days to keep a recording before the retention sweep deletes it; null = keep forever. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) recordingRetentionDays?: number | null;
}

export class SetDahiliDto {
  @IsOptional() @IsString() @ValidateIf((_, v) => v !== null) @MaxLength(10) dahili?: string | null;
  /** The dahili's SIP password (sealed at rest, served only to the owning rep). */
  @IsOptional() @IsString() @MaxLength(120) sipPassword?: string;
  /** The rep's own phone (cell) — first leg for bridge calling (no Netsipp needed). */
  @IsOptional() @IsString() @ValidateIf((_, v) => v !== null) @MaxLength(20) phone?: string | null;
}
