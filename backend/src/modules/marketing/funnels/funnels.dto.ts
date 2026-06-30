import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * A single A/B variant. Previously `variants` was only `@IsArray()` with an
 * inline type — so weight/key arrived unvalidated. A non-numeric weight (e.g.
 * "5" from a hand-rolled client) breaks ExperimentsService.selectVariant's
 * weighted-random math (string concatenation → NaN total → every impression
 * lands on the last variant), and a missing/empty key produces events that
 * trackConversion can never match. Mirrors the validated CampaignVariantDto.
 */
export class ExperimentVariantDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  key: string;

  @IsOptional() @IsString() @MaxLength(160)
  label?: string;

  @IsOptional() @IsInt() @Min(1) @Max(1000)
  weight?: number;

  // Page-builder content for this variant — freeform JSON, rendered (and
  // size-bounded) elsewhere. Whitelisted without shape validation on purpose.
  @Allow()
  blocks?: unknown;
}

export class CreateExperimentDto {
  @IsString() @IsNotEmpty() @MaxLength(160)
  name: string;

  @IsOptional() @IsString()
  pageId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => ExperimentVariantDto)
  variants?: ExperimentVariantDto[];
}

export class UpdateExperimentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160)
  name?: string;

  @IsOptional() @IsString()
  pageId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => ExperimentVariantDto)
  variants?: ExperimentVariantDto[];
}

export class ConvertDto {
  @IsString() @IsNotEmpty()
  variantKey: string;
}

export class CreateSurveyDto {
  @IsString() @IsNotEmpty() @MaxLength(160)
  name: string;

  @IsOptional() @IsArray()
  questions?: unknown[];

  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(2000)
  redirectUrl?: string;
}

export class UpdateSurveyDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160)
  name?: string;

  @IsOptional() @IsArray()
  questions?: unknown[];

  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(2000)
  redirectUrl?: string;

  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED', 'CLOSED'])
  status?: string;
}

export class SurveySubmitDto {
  @IsObject()
  answers: Record<string, unknown>;

  @IsOptional() @IsString()
  leadId?: string;
}
