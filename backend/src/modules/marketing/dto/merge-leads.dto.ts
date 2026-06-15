import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
} from 'class-validator';

export class MergeLeadsDto {
  @IsString()
  @IsNotEmpty()
  canonicalId: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  duplicateIds: string[];
}
