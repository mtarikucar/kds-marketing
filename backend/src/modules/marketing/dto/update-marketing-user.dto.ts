import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsOptional, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CreateMarketingUserDto } from './create-marketing-user.dto';
import { EmptyStringToUndefined } from '../../../common/dto/transforms';

export class UpdateMarketingUserDto extends PartialType(
  OmitType(CreateMarketingUserDto, ['password']),
) {
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: string;

  // Blank means "unchanged" (collapsed to undefined). When present, hold it
  // to the same policy as create: 8-128 chars + complexity (bcryptjs DoS cap).
  @EmptyStringToUndefined()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password?: string;
}
