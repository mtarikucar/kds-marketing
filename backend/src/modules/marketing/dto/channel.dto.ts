import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsObject,
  MaxLength,
} from 'class-validator';

// VOICE belongs here even though its adapter never sends: the inbound voice-AI
// path resolves a call to a Channel row (netgsm-ivr.service.ts matches
// `type: 'VOICE'` on externalId, voice-ai-bridge.controller.ts loads it by id),
// and channels.service.create() is the ONLY code path that writes a Channel.
// Leaving VOICE out of this list meant the row could not be created anywhere in
// the product — the Account Center's Voice "Set up" 400'd, and the IVR lookup
// could only ever find nothing.
const CHANNEL_TYPES = [
  'WEBCHAT',
  'WHATSAPP',
  'SMS',
  'INSTAGRAM',
  'MESSENGER',
  'TIKTOK',
  'EMAIL',
  'VOICE',
];

/**
 * Payload from the WhatsApp Embedded Signup flow: the short-lived OAuth `code`
 * (exchanged server-side for a long-lived business token — never trust a token
 * from the client) plus the WABA + phone-number ids the FB SDK returns.
 */
export class WhatsappEmbeddedSignupDto {
  @IsString() @IsNotEmpty() @MaxLength(2000)
  code: string;

  @IsOptional() @IsString() @MaxLength(64)
  wabaId?: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  phoneNumberId: string;
}

export class CreateChannelDto {
  @IsIn(CHANNEL_TYPES)
  type: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(64)
  agentProfileId?: string;

  /** Provider-side id the inbound webhook resolves by (WA phone_number_id / FB-IG page id). */
  @IsOptional() @IsString() @MaxLength(200)
  externalId?: string;

  /** Secret credentials (tokens/keys) — AES-256-GCM sealed server-side. */
  @IsOptional() @IsObject()
  secrets?: Record<string, string>;

  /** Non-secret public settings (displayName, greeting, allowedOrigins…). */
  @IsOptional() @IsObject()
  configPublic?: Record<string, unknown>;
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(['ACTIVE', 'DISABLED'])
  status?: string;

  @IsOptional() @IsString() @MaxLength(64)
  agentProfileId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  externalId?: string;

  @IsOptional() @IsObject()
  secrets?: Record<string, string>;

  @IsOptional() @IsObject()
  configPublic?: Record<string, unknown>;
}
