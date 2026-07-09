import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /marketing/telephony/calls/:id/transfer body. */
export class TransferCallDto {
  /** The teammate's MarketingUser.dahili to transfer this live call to. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  targetDahili!: string;

  /** true = attended (consult first); false/omitted = blind transfer. */
  @IsOptional()
  @IsBoolean()
  attended?: boolean;
}

/** POST /marketing/telephony/calls/:id/mute body. */
export class MuteCallDto {
  @IsBoolean()
  on!: boolean;
}
