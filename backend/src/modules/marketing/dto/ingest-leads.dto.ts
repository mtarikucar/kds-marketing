import {
  IsArray, ArrayMinSize, ArrayMaxSize, ValidateNested,
  IsString, IsNotEmpty, IsOptional, IsEnum, IsEmail, IsUrl, IsInt, Min,
  Matches, MaxLength, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BUSINESS_TYPE_PATTERN, LeadPriority } from './create-lead.dto';

/**
 * Deterministic dedup key, in researcher priority order: E.164 phone →
 * instagram handle → Google Place ID → apex domain → sha1 of
 * lowercase(businessName|city). Country-agnostic on purpose (was +90-only
 * when the platform served a single Turkish workspace).
 */
export const EXTERNAL_REF_PATTERN =
  /^(phone:\+[1-9]\d{6,14}|instagram:@[A-Za-z0-9_.]{1,30}|google:[A-Za-z0-9_-]{20,}|domain:[a-z0-9][a-z0-9.-]{2,251}\.[a-z]{2,}|hash:[a-f0-9]{40})$/;

/** E.164: + then 7–15 digits, no leading zero. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export class IngestLeadCandidateDto {
  @IsString()
  @Matches(EXTERNAL_REF_PATTERN, {
    message: 'externalRef must match phone:|instagram:|google:|domain:|hash: pattern',
  })
  externalRef: string;

  @IsString() @IsNotEmpty() @MaxLength(255)
  businessName: string;

  @IsOptional() @IsString() @MaxLength(120)
  city?: string;

  @IsOptional() @IsString() @MaxLength(120)
  region?: string;

  @IsString()
  @Matches(BUSINESS_TYPE_PATTERN, {
    message:
      'businessType must be an UPPER_SNAKE taxonomy key (max 60 chars), e.g. CAFE or ECOMMERCE',
  })
  @MaxLength(60)
  businessType: string;

  @IsOptional() @Matches(E164_PATTERN)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(60)
  instagram?: string;

  @IsOptional() @IsUrl()
  website?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsInt() @Min(0)
  branchCount?: number;

  @IsOptional() @IsString() @MaxLength(120)
  currentSystem?: string;

  @IsOptional() @IsIn(['GROWING', 'STRUGGLING', 'STABLE'])
  stage?: string;

  @IsOptional() @IsEnum(LeadPriority)
  priority?: LeadPriority;

  @IsString() @IsNotEmpty() @MaxLength(1000)
  painPoint: string;

  @IsString() @IsNotEmpty() @MaxLength(500)
  evidence: string;

  @IsString() @IsNotEmpty() @MaxLength(500)
  pitch: string;
}

export class IngestLeadsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => IngestLeadCandidateDto)
  leads: IngestLeadCandidateDto[];
}
