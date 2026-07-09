import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * "Leave your number, we call you now" callback (NetGSM Phase 5 Task 6).
 * `redirectMenu` names a pre-existing Netsantral queue/IVR/announcement
 * object — this endpoint cannot create one, only route into it. Shared by
 * the authenticated `POST /marketing/telephony/callback` (rep-triggered) and
 * the public funnel/webchat 'callback' block (visitor-triggered) — both call
 * the SAME `TelephonyCallbackService.requestCallback`, so the İYS-mandatory
 * check is enforced identically regardless of who submitted it.
 */
export class TelephonyCallbackDto {
  @IsString() @IsNotEmpty() @MaxLength(40) phone: string;

  @IsIn(['queue', 'ivr', 'announcement']) redirectType: 'queue' | 'ivr' | 'announcement';

  @IsString() @IsNotEmpty() @MaxLength(120) redirectMenu: string;
}
