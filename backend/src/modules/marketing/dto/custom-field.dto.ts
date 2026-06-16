import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum CustomFieldType {
  TEXT = 'TEXT',
  TEXTAREA = 'TEXTAREA',
  NUMBER = 'NUMBER',
  DATE = 'DATE',
  DATETIME = 'DATETIME',
  BOOL = 'BOOL',
  SELECT = 'SELECT',
  MULTISELECT = 'MULTISELECT',
  URL = 'URL',
  PHONE = 'PHONE',
  EMAIL = 'EMAIL',
}

export class CustomFieldOptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  value: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;
}

export class CreateCustomFieldDefDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  /** Optional explicit slug; otherwise derived from the label. Immutable. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'key must be lower_snake_case' })
  key?: string;

  @IsEnum(CustomFieldType)
  type: CustomFieldType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldOptionDto)
  options?: CustomFieldOptionDto[];

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsInt()
  position?: number;
}

/** key + type are immutable; only label/options/required/position may change. */
export class UpdateCustomFieldDefDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldOptionDto)
  options?: CustomFieldOptionDto[];

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsInt()
  position?: number;
}

export class ReorderCustomFieldsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids: string[];
}

/** Reusable shape for the optional `customFields` map on lead create/update. */
export class CustomFieldValuesDto {
  @IsObject()
  customFields: Record<string, unknown>;
}
