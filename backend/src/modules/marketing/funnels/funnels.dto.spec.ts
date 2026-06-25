// @Type metadata for @ValidateNested needs the reflect-metadata polyfill at load.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateExperimentDto } from './funnels.dto';

/**
 * Regression: CreateExperimentDto.variants was `@IsArray()` only — weight/key
 * arrived unvalidated, breaking the weighted-random selection (NaN weights) and
 * conversion matching (missing keys). These assert the nested validation now in
 * place (mirrors the validated CampaignVariantDto).
 */
async function errorsFor(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateExperimentDto, input);
  return validate(dto);
}

describe('CreateExperimentDto.variants validation', () => {
  it('accepts valid variants (key required, optional int weight, freeform blocks)', async () => {
    const errs = await errorsFor({
      name: 'Homepage hero test',
      variants: [
        { key: 'control', weight: 1, label: 'Control', blocks: [{ type: 'hero' }] },
        { key: 'b' },
      ],
    });
    expect(errs).toEqual([]);
  });

  it('rejects a non-numeric weight', async () => {
    const errs = await errorsFor({ name: 'X', variants: [{ key: 'a', weight: '5' }] });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects weight out of range (0, negative, > 1000)', async () => {
    for (const weight of [0, -3, 1001]) {
      const errs = await errorsFor({ name: 'X', variants: [{ key: 'a', weight }] });
      expect(errs.length).toBeGreaterThan(0);
    }
  });

  it('rejects a variant with a missing/empty key', async () => {
    expect((await errorsFor({ name: 'X', variants: [{ weight: 1 }] })).length).toBeGreaterThan(0);
    expect((await errorsFor({ name: 'X', variants: [{ key: '' }] })).length).toBeGreaterThan(0);
  });

  it('rejects more than 10 variants', async () => {
    const variants = Array.from({ length: 11 }, (_, i) => ({ key: `v${i}` }));
    expect((await errorsFor({ name: 'X', variants })).length).toBeGreaterThan(0);
  });

  it('accepts an experiment with no variants array at all (optional)', async () => {
    expect(await errorsFor({ name: 'X' })).toEqual([]);
  });
});
