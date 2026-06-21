import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
  IsIn,
  IsEmail,
  Min,
  Max,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const CURRENCIES = ['TRY', 'USD', 'EUR'];

/** Fixed line item authored by the manager. unitPrice is minor units. */
export class OrderItemDto {
  @IsString() @IsNotEmpty() @MaxLength(300) description: string;
  @IsInt() @Min(0) @Max(1_000_000) qty: number;
  @IsInt() @Min(0) @Max(100_000_000) unitPrice: number;
}

export class CreateOrderFormDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
  @IsOptional() @IsString() @IsIn(CURRENCIES) currency?: string;
  @IsOptional() @IsBoolean() collectPhone?: boolean;
  @IsOptional() @IsBoolean() phoneRequired?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateOrderFormDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
  @IsOptional() @IsString() @IsIn(CURRENCIES) currency?: string;
  @IsOptional() @IsBoolean() collectPhone?: boolean;
  @IsOptional() @IsBoolean() phoneRequired?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/**
 * Public buyer submission — the buyer's identity ONLY. There is deliberately NO
 * price/amount/product field: the amount is resolved server-side from the form's
 * config, so a buyer can never tamper with what they're charged.
 */
export class PublicOrderSubmitDto {
  @IsString() @IsNotEmpty() @MaxLength(200) fullName: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
}
