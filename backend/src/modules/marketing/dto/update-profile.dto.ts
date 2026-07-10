import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { EmptyStringToUndefined } from '../../../common/dto/transforms';

// Caps mirror CreateMarketingUserDto / iter-46 UpdateProfileDto.
export class UpdateProfileDto {
  @EmptyStringToUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @EmptyStringToUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @EmptyStringToUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be E.164 shape (8-15 digits, optional +)',
  })
  phone?: string;

  // Review fix round 1 (Finding 1) — required only when the caller has
  // SMS-based 2FA armed AND is changing `phone` (enforced in
  // MarketingAuthService.updateProfile); a bcrypt-compared field, so cap it
  // the same as ChangePasswordDto.currentPassword to dodge the same
  // bcryptjs CPU-DoS surface.
  @EmptyStringToUndefined()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
