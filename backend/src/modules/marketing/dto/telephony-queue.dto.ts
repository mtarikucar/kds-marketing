import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /marketing/telephony/agent/presence body (NetGSM Phase 4 Task 4). */
export class AgentPresenceDto {
  /** 'available' -> agentLogin; 'break' -> agentPause(reason). */
  @IsIn(['available', 'break'])
  state!: 'available' | 'break';

  /** Only meaningful for state:'break'; ignored for 'available'. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;
}
