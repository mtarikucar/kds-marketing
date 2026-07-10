import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** NetGSM SMS v2 Task 12 — POST /marketing/leads/:id/verify-phone/confirm body. */
export class VerifyPhoneConfirmDto {
  @IsString() @IsNotEmpty() @MaxLength(20)
  code: string;
}
