import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
  IsIn,
  ArrayNotEmpty,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

export class ReplyDto {
  @IsString() @IsNotEmpty() @MaxLength(4000)
  text: string;
}

/** An internal team-only note on a conversation. */
export class ConversationNoteDto {
  @IsString() @IsNotEmpty() @MaxLength(4000)
  body: string;
}

/** Apply one action to many conversations at once. */
export class BulkConversationDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  conversationIds: string[];

  @IsIn(['close', 'reopen', 'assign', 'markRead'])
  action: 'close' | 'reopen' | 'assign' | 'markRead';

  @IsOptional() @IsString() @MaxLength(64)
  assignedToId?: string | null;
}

export class AssignConversationDto {
  /** null clears the assignment. */
  @IsOptional() @IsString() @MaxLength(64)
  assignedToId?: string | null;
}

export class SetAiPausedDto {
  @IsBoolean()
  paused: boolean;
}

/** Public web-chat: a message from the embedded widget. */
export class WebchatMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  visitorId: string;

  @IsString() @IsNotEmpty() @MaxLength(4000)
  text: string;
}

export class WebchatSessionDto {
  @IsOptional() @IsString() @MaxLength(120)
  visitorId?: string;
}
