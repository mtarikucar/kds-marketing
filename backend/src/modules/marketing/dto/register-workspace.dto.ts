import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsUrl,
  IsIn,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { IsIanaTimeZone } from '../common/iana-timezone';

/**
 * Public self-serve signup: one shot creates the workspace + its OWNER.
 * Length caps mirror the login DTO posture (bcrypt CPU-DoS surface).
 */
export class RegisterWorkspaceDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  workspaceName: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  productName: string;

  @IsOptional() @IsUrl() @MaxLength(255)
  productUrl?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  productDescription?: string;

  @IsOptional() @IsIn(['en', 'tr', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional() @IsIn(['TRY', 'USD', 'EUR'])
  currency?: string;

  /**
   * The IANA zone the BUSINESS operates in — captured here because signup is
   * the one moment we can ask without asking.
   *
   * `Workspace.timezone` has existed since the first migration with a `'UTC'`
   * default, and until now nothing on the self-serve path ever wrote it: the
   * only writer in the codebase was agency.service's createLocation. So every
   * workspace that ever signed up itself holds 'UTC', and every consumer of the
   * column — the dashboard aggregates, the tasks list, sales targets, the daily
   * digest, and the Growth Studio rail on the client — has been computing a
   * Turkish business's day boundaries three hours out. Adding a settings screen
   * fixes the workspaces whose owner finds it; capturing the browser's own
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` at registration is what
   * makes every NEW workspace right without anyone having to know the field
   * exists.
   *
   * Optional on purpose. It is a hint the client volunteers, not a fact the
   * form asks for, and an old client (or a non-browser caller) that omits it
   * must still be able to sign up — it simply lands on the schema default, no
   * worse off than every workspace created before this field existed.
   */
  @IsOptional() @IsIanaTimeZone()
  timezone?: string;

  @IsEmail() @MaxLength(254)
  email: string;

  // Same policy as user-create: min 8, at least one letter and one digit.
  @IsString() @MinLength(8) @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one digit',
  })
  password: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  firstName: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  lastName: string;
}
