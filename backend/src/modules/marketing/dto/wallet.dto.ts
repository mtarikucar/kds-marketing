import { IsInt, Min, Max, IsOptional, IsString, MaxLength } from 'class-validator';

/** Credit or debit a customer wallet. `amount` is positive minor units; the
 *  endpoint decides the sign. Capped well under the int4 balance ceiling. */
export class WalletAdjustDto {
  @IsInt() @Min(1) @Max(2_000_000_000) amount: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
