import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateSegmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // Predicate tree; structurally validated by SegmentCompilerService.validate.
  @IsObject()
  definition: Record<string, unknown>;
}

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;
}

export class PreviewSegmentDto {
  @IsObject()
  definition: Record<string, unknown>;
}
