import {
  IsString, IsNotEmpty, IsOptional, IsBoolean, IsArray, ValidateNested, MaxLength, ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FunnelStepDto {
  @IsString() @IsNotEmpty() @MaxLength(64) sitePageId: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

export class CreateFunnelDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(60) slug?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FunnelStepDto) steps?: FunnelStepDto[];
}

export class UpdateFunnelDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(60) slug?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FunnelStepDto) steps?: FunnelStepDto[];
  @IsOptional() @IsBoolean() published?: boolean;
}
