import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsObject,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { BUSINESS_TYPE_PATTERN } from './create-lead.dto';

export class CreateResearchProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  /** The customer's prompt: who to find + which pain signals to hunt for.
   * Minimum length forces enough substance for the researcher to act on. */
  @IsString() @MinLength(40) @MaxLength(4000)
  icpDescription: string;

  @IsOptional() @IsString() @MaxLength(1000)
  productPitch?: string;

  /** { country?, regions?: string[], cities?: string[] } */
  @IsOptional() @IsObject()
  geo?: Record<string, unknown>;

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

  @IsOptional() @IsObject()
  geo?: Record<string, unknown>;

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
