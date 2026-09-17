import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetWorkspaceBusinessTypesDto } from './set-workspace-business-types.dto';

describe('SetWorkspaceBusinessTypesDto', () => {
  const errors = (businessTypes: unknown) =>
    validate(plainToInstance(SetWorkspaceBusinessTypesDto, { businessTypes }));

  it.each(
    [
      undefined,
      null,
      'OTHER',
      [],
      ['OTHER', 'OTHER'],
      ['lower'],
      ['HAS SPACE'],
      ['_PREFIX'],
      ['A-B'],
      [''],
      [42],
      [null],
      ['A'.repeat(61)],
      Array.from({ length: 101 }, (_, i) => `TYPE_${i}`),
    ].map((value) => [value]),
  )('rejects invalid list %#', async (value) => {
    expect(await errors(value)).not.toHaveLength(0);
  });

  it.each([
    ['OTHER'],
    ['CUSTOM_TYPE', '2ND_TYPE'],
    ['A'.repeat(60)],
    Array.from({ length: 100 }, (_, i) => `TYPE_${i}`),
  ])('accepts valid list %#', async (...values) => {
    expect(await errors(values)).toHaveLength(0);
  });
});
