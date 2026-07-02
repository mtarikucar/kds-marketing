import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BrandingDto } from './marketing-branding.controller';

const errsFor = (obj: Record<string, unknown>) =>
  validateSync(plainToInstance(BrandingDto, obj));

// accentColor must be a #RRGGBB hex — the renderer/branding.service silently drop an
// invalid value to the default, so a bad hex must be REJECTED, not accepted-then-ignored.
describe('BrandingDto.accentColor (hex validation)', () => {
  it('rejects a non-hex color name', () => {
    expect(errsFor({ accentColor: 'red' }).some((e) => e.property === 'accentColor')).toBe(true);
  });

  it('rejects a malformed 7-char value that passes MaxLength', () => {
    expect(errsFor({ accentColor: '#GGGGGG' }).some((e) => e.property === 'accentColor')).toBe(true);
  });

  it('accepts a valid #RRGGBB hex', () => {
    expect(errsFor({ accentColor: '#1e40af' })).toHaveLength(0);
  });

  it('accepts null (the clear signal) — @IsOptional skips the regex', () => {
    expect(errsFor({ accentColor: null })).toHaveLength(0);
  });

  it('accepts an absent accentColor (name-only edit)', () => {
    expect(errsFor({ brandName: 'Acme' })).toHaveLength(0);
  });
});
