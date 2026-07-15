import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Multi-workspace membership (Phase 2 Task 11) — an admin invites someone
 * (by email) into their workspace as MANAGER or REP. OWNER/SYSTEM are never
 * invitable through this surface (mirrors CreateMarketingUserDto's role
 * floor in marketing-users.service.create).
 */
export class InviteMemberDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsIn(['MANAGER', 'REP'])
  role: string;

  /** Epic F granular role (workspace-scoped); overrides `role` when set. */
  @IsOptional()
  @IsString()
  customRoleId?: string;
}
