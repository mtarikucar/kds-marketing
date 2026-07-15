import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  IsIn,
  MaxLength,
} from 'class-validator';

/**
 * Multi-workspace membership — F1: self-serve second-workspace creation
 * (authenticated). Same product-taxonomy fields as RegisterWorkspaceDto
 * MINUS the identity fields (email/password/firstName/lastName) — the
 * caller already has a session and becomes the new workspace's OWNER using
 * their EXISTING MarketingUser identity, not a freshly-created one.
 */
export class CreateWorkspaceDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  workspaceName: string;

  // Optional here (unlike RegisterWorkspaceDto, where it's required for a
  // brand-new org) — a quick second workspace may not need its own product
  // taxonomy yet. MarketingAuthService defaults it to workspaceName when
  // omitted (Workspace.productName is NOT NULL in the schema).
  @IsOptional() @IsString() @MaxLength(120)
  productName?: string;

  @IsOptional() @IsUrl() @MaxLength(255)
  productUrl?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  productDescription?: string;

  @IsOptional() @IsIn(['en', 'tr', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional() @IsIn(['TRY', 'USD', 'EUR'])
  currency?: string;
}
