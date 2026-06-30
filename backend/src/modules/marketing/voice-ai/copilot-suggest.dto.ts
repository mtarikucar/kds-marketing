import { IsString, IsNotEmpty, IsOptional, IsUUID, MaxLength } from 'class-validator';

export class CopilotSuggestDto {
  /** Optional AgentProfile to ground persona/guardrails/language/KB on. */
  @IsOptional()
  @IsUUID()
  agentProfileId?: string;

  /** The running call transcript captured by the browser's speech recognition. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  transcript!: string;
}
