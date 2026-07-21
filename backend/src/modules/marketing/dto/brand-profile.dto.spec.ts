import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OfferingDto, SocialHandleDto } from './brand-profile.dto';

// G2: offerings/socialHandles must reject blank strings — an empty name/network/handle
// would otherwise be silently persisted and surfaced to the AI as grounding context.
describe('OfferingDto', () => {
  it('rejects an empty name', async () => {
    const instance = plainToInstance(OfferingDto, { name: '' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('accepts a valid non-empty name (blurb/price optional)', async () => {
    const instance = plainToInstance(OfferingDto, { name: 'Widget Pro' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid name with optional blurb and price', async () => {
    const instance = plainToInstance(OfferingDto, { name: 'Widget Pro', blurb: 'the best widget', price: '$10' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});

describe('SocialHandleDto', () => {
  it('rejects an empty network', async () => {
    const instance = plainToInstance(SocialHandleDto, { network: '', handle: '@acme' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'network')).toBe(true);
  });

  it('rejects an empty handle', async () => {
    const instance = plainToInstance(SocialHandleDto, { network: 'INSTAGRAM', handle: '' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'handle')).toBe(true);
  });

  it('accepts valid non-empty network and handle', async () => {
    const instance = plainToInstance(SocialHandleDto, { network: 'INSTAGRAM', handle: '@acme' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
