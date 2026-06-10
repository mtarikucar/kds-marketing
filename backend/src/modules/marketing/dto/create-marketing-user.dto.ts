import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsEnum,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum MarketingUserRole {
  MANAGER = 'MANAGER',
  REP = 'REP',
}

// Caps mirror iter-43/46/47 — see MarketingLoginDto for the bcryptjs
// CPU-DoS rationale on password.
export class CreateMarketingUserDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain at least one lowercase letter, one uppercase letter, and one digit',
  })
  password: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  // E.164-ish: 8-15 digits, optional leading +. Mirrors the regex
  // used in customer-orders DTO + orders/CreatePaymentDto (iter-42).
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be E.164 shape (8-15 digits, optional +)',
  })
  phone?: string;

  @IsEnum(MarketingUserRole)
  role: MarketingUserRole;
}
