import { IsString, IsNotEmpty, IsOptional, IsNumber, IsInt, IsDateString, Min, Max } from 'class-validator';
import { EmptyStringToNumber } from '../../../common/dto/transforms';

export class CreateOfferDto {
  @IsString()
  @IsNotEmpty()
  leadId: string;

  @IsOptional()
  @IsString()
  planId?: string;

  @EmptyStringToNumber()
  @IsOptional()
  @IsNumber()
  @Min(0)
  customPrice?: number;

  // discount is a PERCENTAGE (rendered "{discount}%"); cap it at 100 like every
  // other percent/rate DTO field (tax rate, opportunity probability, coupon/
  // affiliate PERCENT). The FE input soft-caps via max=100, but the backend is the
  // authoritative guard — a direct API call could otherwise store "150% off".
  @EmptyStringToNumber()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discount?: number;

  @EmptyStringToNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;
}
