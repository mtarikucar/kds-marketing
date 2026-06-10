import {
  IsString,
  IsEmail,
  IsOptional,
  IsIn,
  IsUrl,
  IsObject,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PlatformLoginDto {
  @IsEmail() @MaxLength(254)
  email: string;

  @IsString() @MinLength(8) @MaxLength(128)
  password: string;
}

export class UpdateWorkspaceStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED', 'CLOSED'])
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
}

export class UpdateWorkspaceAdminDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(120)
  productName?: string;

  @IsOptional() @IsUrl() @MaxLength(255)
  productUrl?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  productDescription?: string;

  @IsOptional() @IsIn(['en', 'tr', 'ru', 'uz', 'ar'])
  defaultLanguage?: string;

  @IsOptional() @IsIn(['TRY', 'USD', 'EUR'])
  defaultCurrency?: string;

  /** Free-shape per-workspace settings (businessTypes, branding…). */
  @IsOptional() @IsObject()
  settings?: Record<string, unknown>;

  /** Core-product wiring ({type:'KDS_CORE', appName, appUrl}) or null to unlink. */
  @IsOptional() @IsObject()
  coreIntegration?: Record<string, unknown> | null;
}
