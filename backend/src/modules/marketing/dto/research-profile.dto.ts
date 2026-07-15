import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  MinLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BUSINESS_TYPE_PATTERN } from './create-lead.dto';

/** The targeting geo. Shape-validated (not a bare @IsObject) because the
 *  research agent's search_places joins regions/cities as arrays — a
 *  string sneaked in via the raw API turned every run into a
 *  ".join is not a function" crash that still consumed the reserved credits. */
export class ResearchGeoDto {
  @IsOptional() @IsString() @MaxLength(80)
  country?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  regions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  cities?: string[];
}

export class CreateResearchProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  /** The customer's prompt: who to find + which pain signals to hunt for.
   * Minimum length forces enough substance for the researcher to act on. */
  @IsString() @MinLength(40) @MaxLength(4000)
  icpDescription: string;

  @IsOptional() @IsString() @MaxLength(1000)
  productPitch?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchGeoDto)
  geo?: ResearchGeoDto;

  @IsOptional() @IsIn(['en', 'tr', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(BUSINESS_TYPE_PATTERN, { each: true })
  businessTypes?: string[];

  @IsOptional() @IsString() @MaxLength(1000)
  exclusions?: string;

  @IsOptional() @IsIn(['ACTIVE', 'PAUSED'])
  status?: 'ACTIVE' | 'PAUSED';
}

export class UpdateResearchProfileDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MinLength(40) @MaxLength(4000)
  icpDescription?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  productPitch?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchGeoDto)
  geo?: ResearchGeoDto;

  @IsOptional() @IsIn(['en', 'tr', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(BUSINESS_TYPE_PATTERN, { each: true })
  businessTypes?: string[];

  @IsOptional() @IsString() @MaxLength(1000)
  exclusions?: string;

  @IsOptional() @IsIn(['ACTIVE', 'PAUSED'])
  status?: 'ACTIVE' | 'PAUSED';
}

export class MintIngestTokenDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  label: string;
}
