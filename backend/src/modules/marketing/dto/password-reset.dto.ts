import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * no-password-recovery — the public forgot/reset bodies.
 *
 * Neither DTO can tell the caller anything: the service answers an unknown
 * address exactly like a known one, and every bad token gets one message. The
 * validation here is only about size and shape, so a malformed body is refused
 * before it reaches a bcrypt compare or an HMAC.
 */
export class ForgotPasswordDto {
  // 254 is the RFC 5321 maximum; the cap keeps an enormous body away from the
  // unique-index lookup behind this route.
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  // Far past any token this service mints (the service refuses longer ones
  // too) — this only stops a multi-megabyte string being parsed and hashed.
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token: string;

  // The same policy as ChangePasswordDto: this is the same act — setting the
  // password on an account that already has one — reached by a different door.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  newPassword: string;
}
