import { IsOptional, IsString, IsObject, IsIn, MaxLength, ValidateIf } from 'class-validator';

export class UpsertTelephonyConfigDto {
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(20) trunk?: string;
  @IsOptional() @IsString() @MaxLength(20) pbxnum?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
}

export class SetDahiliDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(10) dahili?: string | null;
}
