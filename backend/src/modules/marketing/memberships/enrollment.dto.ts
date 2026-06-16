import { IsNotEmpty, IsString } from 'class-validator';

export class EnrollDto {
  @IsString() @IsNotEmpty()
  courseId: string;

  @IsString() @IsNotEmpty()
  leadId: string;
}

export class CompleteLessonDto {
  @IsString() @IsNotEmpty()
  lessonId: string;
}
