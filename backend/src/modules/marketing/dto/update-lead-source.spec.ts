import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateLeadDto } from './update-lead.dto';

/**
 * CSV import (import.service.ts) stamps source='IMPORT' on rows with no source
 * column. Editing such a lead PATCHes its current source back; if the DTO's
 * @IsEnum(LeadSource) rejects 'IMPORT' the save 400s and the lead becomes
 * un-editable — the same class as the AI_RESEARCH/HARDWARE_QUOTE gap. IMPORT
 * must validate as a first-class lead source on the backend too.
 */
describe('UpdateLeadDto source=IMPORT', () => {
  async function sourceErrors(input: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(UpdateLeadDto, input) as object;
    const errors = await validate(dto);
    return errors
      .filter((e) => e.property === 'source')
      .flatMap((e) => Object.values(e.constraints ?? {}));
  }

  it('accepts source=IMPORT so CSV-imported leads stay editable', async () => {
    expect(await sourceErrors({ source: 'IMPORT' })).toEqual([]);
  });

  it('still rejects an unknown source', async () => {
    expect((await sourceErrors({ source: 'NOPE' })).length).toBeGreaterThan(0);
  });
});
