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
