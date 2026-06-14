import { IsDateString, IsObject, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/** Body of POST /api/internal/insights/:workspaceId/digest. */
export class SubmitInsightDigestDto {
  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsObject()
  metrics: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  body: string;
}
