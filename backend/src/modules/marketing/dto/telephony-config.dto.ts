import { IsOptional, IsString, IsObject, IsIn, MaxLength, ValidateIf, Matches } from 'class-validator';

export class UpsertTelephonyConfigDto {
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(20) trunk?: string;
  @IsOptional() @IsString() @MaxLength(20) pbxnum?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
  @IsOptional() @IsString() @MaxLength(255) @Matches(/^wss:\/\//i, { message: 'wssUrl must be a wss:// URL' }) wssUrl?: string;
  @IsOptional() @IsString() @MaxLength(120) sipDomain?: string;
}

export class SetDahiliDto {
  @IsOptional() @IsString() @ValidateIf((_, v) => v !== null) @MaxLength(10) dahili?: string | null;
  /** The dahili's SIP password (sealed at rest, served only to the owning rep). */
  @IsOptional() @IsString() @MaxLength(120) sipPassword?: string;
}
