import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Mirrors OutboundTemplate. Validated rather than passed through as a loose
 *  object so a malformed template is refused here instead of by Meta. */
export class OutboundTemplateDto {
  @IsString() @MinLength(1) @MaxLength(200)
  name: string;

  @IsString() @MinLength(2) @MaxLength(10)
  languageCode: string;

  // @Type is load-bearing, not decoration: the global pipe runs with
  // transform, and an unpinned free-shape array comes out the other side
  // mangled — a WhatsApp template would arrive at Meta with its parameters
  // stripped and the message would go out with empty placeholders.
  @IsOptional() @IsArray() @Type(() => Object)
  components?: unknown[];
}

export class StartConversationDto {
  @IsString() @MinLength(1)
  leadId: string;

  /** Which connected channel to reach them on (SMS, WhatsApp or email). */
  @IsString() @MinLength(1)
  channelId: string;

  @IsOptional() @IsString() @MaxLength(4000)
  text?: string;

  /** WhatsApp outside the 24h session window can only open with an approved
   *  template — Meta rejects free text there, so the caller must supply one. */
  @IsOptional() @ValidateNested() @Type(() => OutboundTemplateDto)
  template?: OutboundTemplateDto;
}
