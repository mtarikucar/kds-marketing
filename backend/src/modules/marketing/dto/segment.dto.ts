import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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

/** Push a segment to a connected Meta ad account as a Custom Audience. */
export class SyncSegmentAudienceDto {
  @IsOptional() @IsBoolean() includePhone?: boolean;
  @IsOptional() @IsBoolean() createLookalike?: boolean;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  @IsOptional() @IsNumber() @Min(0.01) @Max(0.2) ratio?: number;
}
