import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { BUSINESS_TYPE_PATTERN } from './create-lead.dto';

export class SetWorkspaceBusinessTypesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @Matches(BUSINESS_TYPE_PATTERN, { each: true })
  businessTypes: string[];
}
