import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class TwoFactorCodeDto {
  @IsString() @IsNotEmpty() @MaxLength(20)
  code: string;
}

export class Verify2faDto {
  @IsString() @IsNotEmpty() @MaxLength(4000)
  challengeToken: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  code: string;
}
