import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Multi-workspace membership (Phase 2 Task 12) — public accept-invite body.
 * `password` is only meaningful for a brand-new invited identity (Task 11's
 * pending MarketingUser carries an unusable random sentinel, not a real
 * bcrypt hash); whether it's actually REQUIRED depends on server-side state
 * (does this identity already have a real password?) that the DTO can't see,
 * so that enforcement lives in MembershipService.accept, not here.
 */
export class AcceptInviteDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  // Same policy as RegisterWorkspaceDto's password (the other "identity gets
  // a real password for the first time" flow): min 8, at least one letter
  // and one digit.
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one digit',
  })
  password?: string;
}
