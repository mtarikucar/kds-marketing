import {
  ArrayNotEmpty,
  IsArray,
  IsHexColor,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class UpdateTagDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

/** Assign tags to a single lead, by name (unknown names are auto-created). */
export class AssignTagsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags: string[];
}

export class BulkAssignTagsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds: string[];

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  names: string[];
}

export class BulkUnassignTagsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  leadIds: string[];

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  tagIds: string[];
}
