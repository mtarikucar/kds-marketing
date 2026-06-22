import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsInt,
  IsEnum,
  IsDateString,
  IsObject,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { EmptyStringToNumber } from '../../../common/dto/transforms';

/**
 * businessType is a free-form workspace-defined taxonomy value, not a fixed
 * enum — the platform is product-agnostic, so a software vendor's workspace
 * may classify prospects as AGENCY/ECOMMERCE/CLINIC while an F&B-focused one
 * keeps CAFE/RESTAURANT/BAR. UPPER_SNAKE keeps values stable as filter keys
 * (reports group by the raw string); display labels live client-side.
 * DEFAULT_BUSINESS_TYPES seeds new workspaces and remains the fallback list.
 */
export const BUSINESS_TYPE_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,59}$/;

export const DEFAULT_BUSINESS_TYPES = [
  'CAFE',
  'RESTAURANT',
  'BAR',
  'PATISSERIE',
  'FAST_FOOD',
  'OTHER',
] as const;

export enum LeadSource {
  INSTAGRAM = 'INSTAGRAM',
  REFERRAL = 'REFERRAL',
  FIELD_VISIT = 'FIELD_VISIT',
  ADS = 'ADS',
  WEBSITE = 'WEBSITE',
  PHONE = 'PHONE',
  OTHER = 'OTHER',
  AI_RESEARCH = 'AI_RESEARCH',
  // Hardware storefront "Teklif Al" on a QUOTE_ONLY device (yazarkasa / YN ÖKC).
  // Lands an existing tenant's fiscal-device quote request in the lead board.
  HARDWARE_QUOTE = 'HARDWARE_QUOTE',
}

export enum LeadPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export class CreateLeadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  businessName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contactPerson: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsapp?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  @IsString()
  @Matches(BUSINESS_TYPE_PATTERN, {
    message:
      'businessType must be an UPPER_SNAKE taxonomy key (max 60 chars), e.g. CAFE or ECOMMERCE',
  })
  @MaxLength(60)
  businessType: string;

  @EmptyStringToNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  tableCount?: number;

  @EmptyStringToNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  branchCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  currentSystem?: string;

  @IsEnum(LeadSource)
  source: LeadSource;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  nextFollowUp?: string;

  @IsOptional()
  @IsEnum(LeadPriority)
  priority?: LeadPriority;

  @IsOptional()
  @IsString()
  assignedToId?: string;

  /** Epic 6 — B2B account this contact belongs to (Company.id, same workspace).
   *  Empty string on update unlinks; validated against the workspace's companies. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  companyId?: string;

  /**
   * Epic A1 — workspace-defined custom field values, keyed by CustomFieldDef.key.
   * Validated/coerced against the workspace's definitions before persist.
   */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
