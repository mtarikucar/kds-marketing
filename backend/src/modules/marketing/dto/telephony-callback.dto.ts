import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * "Leave your number, we call you now" callback (NetGSM Phase 5 Task 6).
 * `redirectMenu` names a pre-existing Netsantral queue/IVR/announcement
 * object — this endpoint cannot create one, only route into it. Used by the
 * authenticated `POST /marketing/telephony/callback` (rep-triggered, see
 * TelephonyCallbackController) — a rep is trusted to name any of their own
 * workspace's PBX objects directly, so `redirectMenu`/`redirectType` stay
 * request-body fields on this path.
 *
 * The PUBLIC path (`PublicSiteController`'s `POST /api/public/callback/:ws`)
 * does NOT use this DTO for the request body (Final-review fix M2 — see
 * `PublicTelephonyCallbackDto` below): an anonymous visitor must never be
 * able to steer a real outbound call at the tenant's expense to an arbitrary
 * PBX object by supplying `redirectMenu`/`redirectType` themselves, so that
 * path resolves them itself from the tenant's own published callback-block
 * config (`SitesService.resolvePublicCallbackTarget`) and builds this shape
 * server-side before calling the shared `TelephonyCallbackService
 * .requestCallback`.
 */
export class TelephonyCallbackDto {
  @IsString() @IsNotEmpty() @MaxLength(40) phone: string;

  @IsIn(['queue', 'ivr', 'announcement']) redirectType: 'queue' | 'ivr' | 'announcement';

  @IsString() @IsNotEmpty() @MaxLength(120) redirectMenu: string;
}

/**
 * Public (unauthenticated) callback request body — Final-review fix M2. The
 * visitor supplies ONLY their phone number; `redirectMenu`/`redirectType`
 * are deliberately NOT accepted here at all (there is nothing target-shaped
 * in this DTO to tamper with) — `PublicSiteController` resolves the actual
 * dial target from the tenant's own published callback-block config.
 */
export class PublicTelephonyCallbackDto {
  @IsString() @IsNotEmpty() @MaxLength(40) phone: string;
}
