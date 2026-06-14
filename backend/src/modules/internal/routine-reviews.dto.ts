import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReviewDraftDto {
  @IsUUID()
  @IsString()
  @IsNotEmpty()
  reviewId: string;

  @MaxLength(2000)
  @IsString()
  @IsNotEmpty()
  replyDraft: string;
}

/** Body of POST /api/internal/reviews/:workspaceId/drafts. */
export class SubmitReviewDraftsDto {
  @IsArray()
  @ArrayMinSize(1)
  // Keep >= ROUTINE_REVIEW_DAILY_CAP (the GET-side per-workspace cap, default 50):
  // if an operator raises that cap above 50, a single workspace's GET could
  // return more drafts than one POST batch accepts.
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReviewDraftDto)
  drafts: ReviewDraftDto[];
}
