import {
  IsString,
  IsOptional,
  IsIn,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** One product/service line the brand offers — surfaced to the AI as
 *  grounding context (name/blurb/optional price), mirroring the shape
 *  the schema comment documents for BrandProfile.offerings. */
export class OfferingDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  blurb?: string;

  @IsOptional() @IsString() @MaxLength(60)
  price?: string;
}

/** One social handle the brand owns (e.g. { network: 'instagram', handle: '@acme' }). */
export class SocialHandleDto {
  @IsString() @MaxLength(60)
  network: string;

  @IsString() @MaxLength(200)
  handle: string;
}

/** Payload for GET/PUT marketing/brand-brain/profile. Partial-safe — every
 *  field is optional so a PUT only touches what the caller actually sent
 *  (see BrandProfileService.upsert). */
export class BrandProfilePayload {
  @IsOptional() @IsString() @MaxLength(200)
  brandName?: string;

  @IsOptional() @IsString() @MaxLength(300)
  tagline?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  valueProps?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  toneWords?: string[];

  @IsOptional() @IsString() @MaxLength(4000)
  voiceGuide?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  icpDescription?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  audienceObjections?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => OfferingDto)
  offerings?: OfferingDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SocialHandleDto)
  socialHandles?: SocialHandleDto[];

  @IsOptional() @IsIn(['DRAFT', 'ACTIVE'])
  status?: 'DRAFT' | 'ACTIVE';
}
