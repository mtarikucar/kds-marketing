import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsArray,
  IsIn,
  IsInt,
  Min,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/** A single estimate line item. unitPrice is in minor units (kuruş/cents). */
export class EstimateItemDto {
  @IsString() @IsNotEmpty() @MaxLength(300) description: string;
  @IsInt() @Min(0) qty: number;
  @IsInt() @Min(0) unitPrice: number;
}

export class CreateEstimateDto {
  @IsOptional() @IsString() leadId?: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EstimateItemDto)
  items: EstimateItemDto[];
  @IsOptional() @IsString() @IsIn(['TRY', 'USD', 'EUR']) currency?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsDateString() validUntil?: string;
}

export class UpdateEstimateDto {
  @IsOptional() @IsString() leadId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EstimateItemDto)
  items?: EstimateItemDto[];
  @IsOptional() @IsString() @IsIn(['TRY', 'USD', 'EUR']) currency?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsDateString() validUntil?: string;
}
