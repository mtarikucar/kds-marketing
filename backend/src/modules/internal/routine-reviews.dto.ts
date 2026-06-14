import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReviewDraftDto {
  @IsString()
  @IsNotEmpty()
  reviewId: string;

  @IsString()
  @IsNotEmpty()
  replyDraft: string;
}

/** Body of POST /api/internal/reviews/:workspaceId/drafts. */
export class SubmitReviewDraftsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReviewDraftDto)
  drafts: ReviewDraftDto[];
}
