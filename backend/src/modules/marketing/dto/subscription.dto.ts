import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsIn,
  Min,
  Max,
  MaxLength,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/** A recurring line item. unitPrice is in minor units (kuruş/cents). */
export class SubscriptionItemDto {
  @IsString() @IsNotEmpty() @MaxLength(300) description: string;
  @IsInt() @Min(0) @Max(1_000_000) qty: number;
  @IsInt() @Min(0) @Max(100_000_000) unitPrice: number;
}

export class CreateSubscriptionDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SubscriptionItemDto)
  items: SubscriptionItemDto[];
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() @IsIn(['TRY', 'USD', 'EUR']) currency?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @IsIn(['MONTH', 'YEAR', 'WEEK']) interval?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) intervalCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) dueDays?: number;
  @IsOptional() @IsDateString() startAt?: string;
}

export class UpdateSubscriptionDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SubscriptionItemDto)
  items?: SubscriptionItemDto[];
  @IsOptional() @IsString() @IsIn(['TRY', 'USD', 'EUR']) currency?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @IsIn(['MONTH', 'YEAR', 'WEEK']) interval?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) intervalCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) dueDays?: number;
}
