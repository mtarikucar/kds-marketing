import { IsString, IsNotEmpty } from 'class-validator';

export class SwitchWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;
}
