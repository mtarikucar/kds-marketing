import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ProductFilterDto } from './product.dto';

// The global ValidationPipe runs with these transform options (app.config.ts).
const OPTS = { enableImplicitConversion: true } as const;

describe('ProductFilterDto.active (query boolean coercion)', () => {
  it('parses ?active=false as false (not the implicit-conversion Boolean("false")===true)', () => {
    const dto = plainToInstance(ProductFilterDto, { active: 'false' }, OPTS);
    // Regression: with @Type(() => Boolean)+enableImplicitConversion this coerced
    // to true, so the "show inactive products" filter returned ACTIVE products.
    expect(dto.active).toBe(false);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('parses ?active=true as true', () => {
    const dto = plainToInstance(ProductFilterDto, { active: 'true' }, OPTS);
    expect(dto.active).toBe(true);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('leaves active undefined when the param is absent (no filter)', () => {
    const dto = plainToInstance(ProductFilterDto, {}, OPTS);
    expect(dto.active).toBeUndefined();
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('passes a real boolean through unchanged', () => {
    expect(plainToInstance(ProductFilterDto, { active: true }, OPTS).active).toBe(true);
    expect(plainToInstance(ProductFilterDto, { active: false }, OPTS).active).toBe(false);
  });
});
