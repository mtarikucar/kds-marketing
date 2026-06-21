import { IsOptional, IsString, IsObject, IsIn, MaxLength } from 'class-validator';

export class UpsertTelephonyConfigDto {
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(20) trunk?: string;
  @IsOptional() @IsString() @MaxLength(20) pbxnum?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
}

export class SetDahiliDto {
  @IsOptional() @IsString() @MaxLength(10) dahili?: string;
}
