import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateOfferDto } from './create-offer.dto';

const base = { leadId: 'lead-1' };
const errsFor = (obj: Record<string, unknown>) =>
  validateSync(plainToInstance(CreateOfferDto, { ...base, ...obj }));

// discount is a percentage ("{discount}%"), so it must be capped at 100 like every
// other percent/rate DTO field — a direct API call must not store "150% off".
describe('CreateOfferDto.discount (percentage cap)', () => {
  it('rejects a discount above 100', () => {
    const errs = errsFor({ discount: 150 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.property === 'discount')).toBe(true);
  });

  it('accepts a discount of exactly 100', () => {
    expect(errsFor({ discount: 100 })).toHaveLength(0);
  });

  it('accepts a normal discount (25)', () => {
    expect(errsFor({ discount: 25 })).toHaveLength(0);
  });

  it('rejects a negative discount', () => {
    expect(errsFor({ discount: -5 }).some((e) => e.property === 'discount')).toBe(true);
  });
});
