import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateApiKeyDto } from './api-key.dto';
import { PERMISSIONS } from '../roles/permissions';

/**
 * Gap 1 (mcp-write-surface-activation Task 5) — `jeeta.reallocate_budget`
 * declares `scopes: ['settings.manage']`, but before this DTO widened, no key
 * anyone could mint through the API ever carried that scope: `@IsIn` only
 * allowed 'read'/'write'. This pins that every granular permission in
 * `PERMISSIONS` is now a legal scope, while 'read'/'write' keep working as
 * legacy shorthands, and that the vocabulary is still closed (garbage is
 * still rejected).
 */
describe('CreateApiKeyDto', () => {
  const validate_ = async (scopes: unknown) => {
    const dto = plainToInstance(CreateApiKeyDto, { name: 'k', scopes });
    return validate(dto);
  };

  it('accepts the legacy "read" shorthand', async () => {
    expect(await validate_(['read'])).toHaveLength(0);
  });

  it('accepts the legacy "write" shorthand', async () => {
    expect(await validate_(['write'])).toHaveLength(0);
  });

  it('accepts every granular permission from roles/permissions.ts, including settings.manage', async () => {
    for (const p of PERMISSIONS) {
      const errors = await validate_([p]);
      expect(errors).toHaveLength(0);
    }
  });

  it('accepts settings.manage specifically (the reallocate_budget scope)', async () => {
    expect(await validate_(['settings.manage'])).toHaveLength(0);
  });

  it('accepts campaigns.write specifically (the draft_social_post scope)', async () => {
    expect(await validate_(['campaigns.write'])).toHaveLength(0);
  });

  it('accepts a mix of legacy and granular scopes', async () => {
    expect(await validate_(['read', 'settings.manage'])).toHaveLength(0);
  });

  it('rejects a scope string outside the vocabulary', async () => {
    const errors = await validate_(['not-a-real-scope']);
    expect(errors.some((e) => e.property === 'scopes')).toBe(true);
  });

  it('rejects an empty scopes array', async () => {
    const errors = await validate_([]);
    expect(errors.some((e) => e.property === 'scopes')).toBe(true);
  });

  it('leaves scopes optional (undefined is valid — ApiKeysService defaults it)', async () => {
    const dto = plainToInstance(CreateApiKeyDto, { name: 'k' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
