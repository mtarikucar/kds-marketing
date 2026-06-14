import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsIn,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ContentDraftDto {
  @IsIn(['social', 'email', 'sms'])
  channel: 'social' | 'email' | 'sms';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body: string;
}

/** Body of POST /api/internal/content/jobs/:workspaceId/drafts. */
export class SubmitContentDraftsDto {
  @IsUUID()
  profileId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ContentDraftDto)
  drafts: ContentDraftDto[];
}
