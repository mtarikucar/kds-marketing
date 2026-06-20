import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsIn,
  Min,
  Max,
  MaxLength,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

const CURRENCIES = ['TRY', 'USD', 'EUR'];
const BILLING_TYPES = ['ONE_TIME', 'RECURRING'];
const INTERVALS = ['MONTH', 'YEAR'];

export class CreateProductDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() @IsIn(CURRENCIES) currency?: string;
  @IsOptional() @IsString() @IsIn(BILLING_TYPES) billingType?: string;
  @IsOptional() @IsString() @IsIn(INTERVALS) interval?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxRate?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() @IsIn(CURRENCIES) currency?: string;
  @IsOptional() @IsString() @IsIn(BILLING_TYPES) billingType?: string;
  @IsOptional() @IsString() @IsIn(INTERVALS) interval?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxRate?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ProductFilterDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsString() @IsIn(BILLING_TYPES) billingType?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
