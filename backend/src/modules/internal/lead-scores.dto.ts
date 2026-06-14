import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LeadScoreDto {
  @IsUUID()
  leadId: string;

  @IsInt()
  @Min(0)
  @Max(100)
  score: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** Body of POST /api/internal/lead-scoring/:workspaceId/scores. */
export class SubmitLeadScoresDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LeadScoreDto)
  scores: LeadScoreDto[];
}
