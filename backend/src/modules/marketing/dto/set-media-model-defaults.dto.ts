import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * The workspace's default image / video model — the middle term of
 * `campaign override ?? workspace default ?? code constant`.
 *
 * PARTIAL on purpose, with three distinct meanings for a field:
 *   absent — leave this half of the card alone (saving the video model must not
 *            silently reset the image model);
 *   null   — clear the choice, back to the platform default;
 *   string — choose that model.
 *
 * `@IsOptional()` skips validation for `null` as well as `undefined`, which is
 * exactly the shape needed: the property SURVIVES onto the DTO when the client
 * sent an explicit null, so the service can tell "clear it" from "did not say".
 * `@ValidateIf(... !== null)` is what keeps the string rules applying to a real
 * value while letting the null through.
 *
 * The catalogue itself is NOT validated here. Membership (and the KIND match)
 * is `MediaModelDefaultsService`'s job because the catalogue lives in code and
 * changes with a deploy, and because the refusal has to name the alternatives —
 * a DTO-level `@IsIn` would 400 with a bare "invalid value" for the one decision
 * in this product where the caller most needs to be told what the options cost.
 */
export class SetMediaModelDefaultsDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  defaultImageModel?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  defaultVideoModel?: string | null;
}
