import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateExperimentDto {
  @IsString() @IsNotEmpty() @MaxLength(160)
  name: string;

  @IsOptional() @IsString()
  pageId?: string;

  @IsOptional() @IsArray()
  variants?: { key: string; label?: string; weight?: number; blocks?: unknown }[];
}

export class UpdateExperimentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160)
  name?: string;

  @IsOptional() @IsString()
  pageId?: string;

  @IsOptional() @IsArray()
  variants?: { key: string; label?: string; weight?: number; blocks?: unknown }[];
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
