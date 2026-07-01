import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsOptional,
  IsString,
  IsNumber,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * End-customer invoice line item. Caps bound the per-item free text and the
 * numeric magnitudes that feed computeTotal (qty * unitPrice), so a single
 * payload can't smuggle absurd values into the persisted JSON / total.
 */
export class InvoiceItemDto {
  @IsString()
  @MaxLength(500)
  description: string;

  // qty + unitPrice are INTEGER minor-unit magnitudes (unitPrice = kuruş/cents),
  // matching the estimate/order-form/subscription line DTOs and money.util's
  // integer math. @IsNumber let a fractional qty through, which computeMoneyTotals
  // then silently ROUNDED (2.5 → billed as 3) — an over-bill. Reject it here.
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  qty: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  unitPrice: number;

  /** Optional TaxRate id; the server re-snapshots the rate (client pct ignored). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxRateId?: string;
}

export class CreateInvoiceDto {
  @IsOptional() @IsString() @MaxLength(64) leadId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items: InvoiceItemDto[];

  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @MaxLength(40) dueDate?: string;
}

export class UpdateInvoiceDto {
  // items is optional on update (partial edit). ArrayMinSize is NOT enforced
  // here so an existing invoice's non-items fields can be patched alone; when
  // items IS present it's still bounded + nested-validated.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items?: InvoiceItemDto[];

  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @MaxLength(40) dueDate?: string;
}
