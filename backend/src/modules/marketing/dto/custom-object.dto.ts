import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  Matches,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Define a new custom object type. `key` is the immutable slug (per workspace). */
export class CreateCustomObjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'key must be lower_snake_case' })
  key: string;

  @IsString() @IsNotEmpty() @MaxLength(80) labelSingular: string;
  @IsString() @IsNotEmpty() @MaxLength(80) labelPlural: string;

  /** Field key whose value is the record's display name (default "name"). */
  @IsOptional() @IsString() @MaxLength(64) primaryField?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(64) icon?: string;
}

/** key is immutable; only labels / primaryField / description / icon may change. */
export class UpdateCustomObjectDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) labelSingular?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) labelPlural?: string;
  @IsOptional() @IsString() @MaxLength(64) primaryField?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(64) icon?: string;
}

/** Create/update a record: `values` is validated against the object's fields. */
export class UpsertRecordDto {
  @IsObject() values: Record<string, unknown>;
}

/** Associate a record with a Contact (Lead). */
export class LinkContactDto {
  @IsString() @IsNotEmpty() @MaxLength(64) leadId: string;
  @IsOptional() @IsString() @MaxLength(80) label?: string;
}

/** List/search records for an object. */
export class RecordQueryDto {
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
}
