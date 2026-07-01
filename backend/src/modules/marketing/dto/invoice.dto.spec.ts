// class-transformer's @Type metadata (nested InvoiceItemDto) needs the
// polyfill at module load — same as marketing-dto-limits.spec.ts.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInvoiceDto } from './invoice.dto';

describe('Invoice DTO bounds', () => {
  async function validateDto(cls: any, input: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(cls, input) as object;
    const errors = await validate(dto);
    // Flatten nested (items[]) constraint messages too.
    const collect = (errs: any[]): string[] =>
      errs.flatMap((e) => [
        ...Object.values(e.constraints ?? {} as Record<string, string>),
        ...(e.children?.length ? collect(e.children) : []),
      ]) as string[];
    return collect(errors);
  }

  const item = { description: 'Widget', qty: 2, unitPrice: 100 };

  it('accepts a valid single-item invoice', async () => {
    expect(await validateDto(CreateInvoiceDto, { items: [item] })).toEqual([]);
  });

  it('rejects empty items (ArrayMinSize)', async () => {
    const msgs = await validateDto(CreateInvoiceDto, { items: [] });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects > 200 items (ArrayMaxSize)', async () => {
    const msgs = await validateDto(CreateInvoiceDto, {
      items: Array.from({ length: 201 }, () => ({ ...item })),
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects a negative qty', async () => {
    const msgs = await validateDto(CreateInvoiceDto, {
      items: [{ ...item, qty: -1 }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  // qty/unitPrice are integer minor-unit magnitudes (parity with estimate/
  // order-form/subscription DTOs + money.util's integer math). A fractional qty
  // was silently ROUNDED by computeMoneyTotals (2.5 → billed as 3) → an over-bill;
  // reject it at the DTO instead.
  it('rejects a fractional qty', async () => {
    const msgs = await validateDto(CreateInvoiceDto, {
      items: [{ ...item, qty: 2.5 }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects a fractional unitPrice (minor units are integers)', async () => {
    const msgs = await validateDto(CreateInvoiceDto, {
      items: [{ ...item, unitPrice: 19.99 }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects unitPrice over the 1,000,000 cap', async () => {
    const msgs = await validateDto(CreateInvoiceDto, {
      items: [{ ...item, unitPrice: 2_000_000 }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects a description > 500 chars', async () => {
    const msgs = await validateDto(CreateInvoiceDto, {
      items: [{ ...item, description: 'a'.repeat(501) }],
    });
    expect(msgs.length).toBeGreaterThan(0);
  });
});
