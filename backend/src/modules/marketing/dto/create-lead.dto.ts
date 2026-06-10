import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsInt,
  IsEnum,
  IsDateString,
  Min,
} from 'class-validator';
import { EmptyStringToNumber } from '../../../common/dto/transforms';

export enum BusinessType {
  CAFE = 'CAFE',
  RESTAURANT = 'RESTAURANT',
  BAR = 'BAR',
  PATISSERIE = 'PATISSERIE',
  FAST_FOOD = 'FAST_FOOD',
  OTHER = 'OTHER',
}

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
  businessName: string;

  @IsString()
  @IsNotEmpty()
  contactPerson: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsEnum(BusinessType)
  businessType: BusinessType;

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
  currentSystem?: string;

  @IsEnum(LeadSource)
  source: LeadSource;

  @IsOptional()
  @IsString()
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
}
