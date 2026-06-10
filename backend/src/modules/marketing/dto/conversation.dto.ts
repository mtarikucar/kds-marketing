import { IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class ReplyDto {
  @IsString() @IsNotEmpty() @MaxLength(4000)
  text: string;
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
