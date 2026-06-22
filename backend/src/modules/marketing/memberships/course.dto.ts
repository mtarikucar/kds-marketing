import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CertificateTemplateDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(120) signature?: string;
  @IsOptional() @IsString() @MaxLength(2000) logoUrl?: string;
}

export class CreateCourseDto {
  @IsString() @IsNotEmpty() @MaxLength(160)
  title: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsInt() @Min(0)
  priceCents?: number;

  @IsOptional() @IsString() @MaxLength(8)
  currency?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  coverImageUrl?: string;
}

export class UpdateCourseDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160)
  title?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsInt() @Min(0)
  priceCents?: number;

  @IsOptional() @IsString() @MaxLength(8)
  currency?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  coverImageUrl?: string;

  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
  status?: string;

  @IsOptional() @IsIn(['FREE', 'SEQUENTIAL', 'DRIP'])
  dripMode?: string;

  @IsOptional() @IsBoolean()
  certificateEnabled?: boolean;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => CertificateTemplateDto)
  certificateTemplate?: CertificateTemplateDto;
}

export class ModuleDto {
  @IsString() @IsNotEmpty() @MaxLength(160)
  title: string;
}

export class LessonDto {
  @IsOptional() @IsString() @MaxLength(200)
  title?: string;

  @IsOptional() @IsIn(['VIDEO', 'TEXT', 'PDF', 'QUIZ'])
  type?: string;

  @IsOptional() @IsString() @MaxLength(100000)
  content?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  videoUrl?: string;

  @IsOptional() @IsInt() @Min(0)
  durationSec?: number;

  @IsOptional() @IsBoolean()
  isPreview?: boolean;

  @IsOptional() @IsIn(['FREE', 'SEQUENTIAL', 'DRIP'])
  gating?: string;

  @IsOptional() @IsInt() @Min(0) @Max(3650)
  dripDays?: number;
}

export class ReorderDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  ids: string[];
}
