import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ExperimentsService } from './experiments.service';
import { SurveysService } from './surveys.service';
import { ConvertDto, SurveySubmitDto } from './funnels.dto';

/**
 * Epic E — public (unauthenticated) endpoints a funnel page calls: pick an A/B
 * variant + record the impression, record a conversion, and submit a survey.
 * Looked up by the unguessable id (same pattern as public form submits).
 */
@Controller('public')
export class PublicFunnelsController {
  constructor(
    private readonly experiments: ExperimentsService,
    private readonly surveys: SurveysService,
  ) {}

  @Get('exp/:id/variant')
  async variant(@Param('id') id: string) {
    const chosen = await this.experiments.selectVariant(id);
    if (!chosen) throw new NotFoundException('No running experiment');
    return chosen;
  }

  @Post('exp/:id/convert')
  convert(@Param('id') id: string, @Body() dto: ConvertDto) {
    return this.experiments.trackConversion(id, dto.variantKey);
  }

  @Post('survey/:id/submit')
  submitSurvey(@Param('id') id: string, @Body() dto: SurveySubmitDto) {
    return this.surveys.submit(id, dto.answers, dto.leadId);
  }
}
