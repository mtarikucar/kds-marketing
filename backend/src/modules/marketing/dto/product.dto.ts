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
import { Type, Transform } from 'class-transformer';

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
  // The global ValidationPipe runs enableImplicitConversion, which coerces every
  // query STRING via Boolean(value) — so `?active=false` becomes Boolean('false')
  // === true and the "inactive products" filter silently returns ACTIVE products.
  // Implicit conversion has already replaced `value`, so read the RAW string off
  // obj[key] and map it explicitly (mirrors the string+parse convention used for
  // other query booleans, e.g. marketing-notifications `isRead`).
  @IsOptional()
  @Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  })
  @IsBoolean()
  active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
