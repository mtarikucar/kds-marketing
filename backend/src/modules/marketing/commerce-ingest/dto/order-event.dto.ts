import { Type, plainToInstance } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidationError,
  validate,
} from 'class-validator';

/** Postgres INTEGER — amounts are minor units and must fit the column. */
const MAX_MINOR = 2_147_483_647;
/** `occurredAt` may run ahead of our clock by this much, no more (contract §1.3). */
export const OCCURRED_AT_FUTURE_SKEW_MS = 5 * 60_000;

export const ORDER_EVENTS = ['order.created', 'order.paid', 'order.refunded', 'order.cancelled'] as const;
export type OrderEventType = (typeof ORDER_EVENTS)[number];

export class OrderItemDto {
  @IsOptional() @IsString() @MaxLength(120) sku?: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsInt() @Min(1) @Max(10_000) qty!: number;
  @IsInt() @Min(0) @Max(MAX_MINOR) unitMinor!: number;
}

export class OrderDto {
  @IsString() @MinLength(1) @MaxLength(120) externalId!: string;
  @IsOptional() @IsString() @MaxLength(120) groupRef?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) createdAt?: string;
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code in capitals, e.g. TRY' }) currency!: string;
  @IsInt() @Min(0) @Max(MAX_MINOR) amountMinor!: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MINOR) refundedMinor?: number;
  @IsOptional() @IsString() @MaxLength(40) paymentMethod?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
}

export class CustomerDto {
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}

export class AttributionDto {
  @IsOptional() @IsString() @MaxLength(512) utmSource?: string | null;
  @IsOptional() @IsString() @MaxLength(512) utmMedium?: string | null;
  @IsOptional() @IsString() @MaxLength(512) utmCampaign?: string | null;
  @IsOptional() @IsString() @MaxLength(512) utmContent?: string | null;
  @IsOptional() @IsString() @MaxLength(512) utmTerm?: string | null;
  @IsOptional() @IsString() @MaxLength(512) fbclid?: string | null;
  @IsOptional() @IsString() @MaxLength(512) gclid?: string | null;
  @IsOptional() @IsString() @MaxLength(512) ttclid?: string | null;
  @IsOptional() @IsString() @MaxLength(512) landingUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(512) referrer?: string | null;
}

/** Order webhook body, schema v1 (contract §1.3). */
export class OrderEventDto {
  @IsIn([1]) version!: 1;
  @IsString() @MinLength(1) @MaxLength(200) eventId!: string;
  @IsIn(ORDER_EVENTS as unknown as string[]) event!: OrderEventType;
  @IsISO8601({ strict: true }) occurredAt!: string;
  @ValidateNested() @Type(() => OrderDto) order!: OrderDto;
  @IsOptional() @ValidateNested() @Type(() => CustomerDto) customer?: CustomerDto;
  @IsOptional() @ValidateNested() @Type(() => AttributionDto) attribution?: AttributionDto;
}

export type OrderEventV1 = OrderEventDto;

export type ParseResult =
  | { ok: true; event: OrderEventV1 }
  | {
      ok: false;
      code: 'MALFORMED_JSON' | 'UNSUPPORTED_VERSION' | 'VALIDATION_FAILED';
      message: string;
      details?: string[];
    };

/**
 * Bytes → a validated event. Runs only AFTER the signature has been verified,
 * so nothing here is reachable by a caller without the source secret.
 *
 * The global ValidationPipe never sees this body (it is raw for the HMAC), so
 * its `forbidNonWhitelisted` rule is applied here by hand: an unknown field is
 * a 400, not something silently dropped.
 */
export async function parseOrderEvent(raw: Buffer, now = Date.now()): Promise<ParseResult> {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', message: 'The body is not valid JSON.' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, code: 'MALFORMED_JSON', message: 'The body must be a JSON object.' };
  }
  const version = (json as Record<string, unknown>).version;
  if (version !== 1) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      message: `Unsupported schema version ${JSON.stringify(version ?? null)}; this endpoint accepts version 1.`,
    };
  }

  const event = plainToInstance(OrderEventDto, json);
  const errors = await validate(event, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  const details = flatten(errors);

  if (details.length === 0) {
    const refunded = event.order.refundedMinor ?? 0;
    if (refunded > event.order.amountMinor) details.push('order.refundedMinor must not exceed order.amountMinor');
    if (Date.parse(event.occurredAt) > now + OCCURRED_AT_FUTURE_SKEW_MS) {
      details.push('occurredAt is more than 5 minutes in the future');
    }
  }
  if (details.length) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'The order event failed validation.', details };
  }
  return { ok: true, event };
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    for (const msg of Object.values(e.constraints ?? {})) out.push(`${path}: ${msg}`);
    out.push(...flatten(e.children ?? [], path));
  }
  return out;
}
