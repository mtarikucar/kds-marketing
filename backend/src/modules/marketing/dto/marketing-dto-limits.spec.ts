// class-transformer's @Type metadata (pulled in via IngestLeadCandidateDto)
// needs the polyfill at module load — same as transforms.spec.ts.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarketingLoginDto } from './login.dto';
import { RefreshTokenDto } from './refresh-token.dto';
import {
  CreateMarketingUserDto,
  MarketingUserRole,
} from './create-marketing-user.dto';
import { UpdateProfileDto } from './update-profile.dto';
import { IngestLeadCandidateDto } from './ingest-leads.dto';
import { ChangePasswordDto } from './change-password.dto';
import { UpdateMarketingUserDto } from './update-marketing-user.dto';
import { CreateLeadDto, LeadSource } from './create-lead.dto';
import { BookSlotDto } from './public-site.dto';

/**
 * Iter-49 regression: marketing is the third auth realm in the
 * codebase (after tenant + superadmin). Same bcryptjs CPU-DoS surface
 * iter-43 / iter-46 / iter-47 closed elsewhere — replicate here.
 */
describe('Marketing DTO length caps (iter-49)', () => {
  async function validateDto(cls: any, input: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(cls, input) as object;
    const errors = await validate(dto);
    return errors.flatMap((e) => Object.values(e.constraints ?? {}));
  }

  describe('MarketingLoginDto', () => {
    const base = { email: 'rep@example.com', password: 'Pass1234' };

    it('accepts a normal login', async () => {
      expect(await validateDto(MarketingLoginDto, base)).toEqual([]);
    });

    it('rejects password > 128 (bcryptjs DoS — third auth realm)', async () => {
      const msgs = await validateDto(MarketingLoginDto, {
        ...base,
        password: 'a'.repeat(129),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects oversize emails', async () => {
      const msgs = await validateDto(MarketingLoginDto, {
        ...base,
        email: 'a'.repeat(255) + '@x.com',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  describe('RefreshTokenDto', () => {
    it('rejects refreshToken > 4096 chars', async () => {
      const msgs = await validateDto(RefreshTokenDto, {
        refreshToken: 'a'.repeat(4097),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('accepts a normal JWT-sized token', async () => {
      expect(
        await validateDto(RefreshTokenDto, { refreshToken: 'a'.repeat(800) }),
      ).toEqual([]);
    });
  });

  describe('CreateMarketingUserDto', () => {
    const base = {
      email: 'rep@example.com',
      password: 'Passw0rd1',
      firstName: 'Alice',
      lastName: 'Rep',
      role: MarketingUserRole.REP,
    };

    it('accepts a typical create', async () => {
      expect(await validateDto(CreateMarketingUserDto, base)).toEqual([]);
    });

    it('rejects password > 128', async () => {
      const msgs = await validateDto(CreateMarketingUserDto, {
        ...base,
        password: 'Aa1' + 'b'.repeat(126),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects oversize firstName', async () => {
      const msgs = await validateDto(CreateMarketingUserDto, {
        ...base,
        firstName: 'a'.repeat(101),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects malformed phone (regex)', async () => {
      const msgs = await validateDto(CreateMarketingUserDto, {
        ...base,
        phone: 'not-a-phone',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('accepts E.164 phone', async () => {
      expect(
        await validateDto(CreateMarketingUserDto, {
          ...base,
          phone: '+905551234567',
        }),
      ).toEqual([]);
    });
  });

  describe('UpdateProfileDto', () => {
    it('rejects firstName > 100', async () => {
      const msgs = await validateDto(UpdateProfileDto, {
        firstName: 'a'.repeat(101),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects garbage phone (newly-validated regex)', async () => {
      const msgs = await validateDto(UpdateProfileDto, { phone: 'abc' });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  /**
   * Genericization: the ingest contract is country/product-agnostic —
   * externalRef accepts any E.164 phone + the new domain: form, and
   * businessType is a workspace taxonomy key instead of the old F&B enum.
   */
  describe('IngestLeadCandidateDto (generic taxonomy + E.164)', () => {
    const base = {
      externalRef: 'phone:+905551234567',
      businessName: 'Acme Coffee',
      businessType: 'CAFE',
      painPoint: 'Slow service complaints in recent reviews',
      evidence: 'https://maps.example.com/review/1',
      pitch: 'Cut wait times with digital ordering',
    };

    it('accepts a TR E.164 phone ref (back-compat)', async () => {
      expect(await validateDto(IngestLeadCandidateDto, base)).toEqual([]);
    });

    it('accepts non-TR E.164 phone refs and phones', async () => {
      expect(
        await validateDto(IngestLeadCandidateDto, {
          ...base,
          externalRef: 'phone:+4915123456789',
          phone: '+12025550123',
        }),
      ).toEqual([]);
    });

    it('accepts the new domain: ref form', async () => {
      expect(
        await validateDto(IngestLeadCandidateDto, {
          ...base,
          externalRef: 'domain:acme-coffee.example.com',
        }),
      ).toEqual([]);
    });

    it('accepts a workspace-defined businessType outside the F&B defaults', async () => {
      expect(
        await validateDto(IngestLeadCandidateDto, {
          ...base,
          businessType: 'ECOMMERCE',
        }),
      ).toEqual([]);
    });

    it('rejects lowercase/malformed businessType keys', async () => {
      const msgs = await validateDto(IngestLeadCandidateDto, {
        ...base,
        businessType: 'cafe shop',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects refs without a known prefix', async () => {
      const msgs = await validateDto(IngestLeadCandidateDto, {
        ...base,
        externalRef: 'tel:+905551234567',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects non-E.164 phones (leading zero)', async () => {
      const msgs = await validateDto(IngestLeadCandidateDto, {
        ...base,
        phone: '+05551234567',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  describe('ChangePasswordDto', () => {
    const base = { currentPassword: 'OldPass1', newPassword: 'NewPass1' };

    it('accepts a normal change', async () => {
      expect(await validateDto(ChangePasswordDto, base)).toEqual([]);
    });

    it('rejects newPassword > 128 (bcryptjs DoS cap)', async () => {
      const msgs = await validateDto(ChangePasswordDto, {
        ...base,
        newPassword: 'Aa1' + 'b'.repeat(126),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects a weak newPassword (no complexity)', async () => {
      const msgs = await validateDto(ChangePasswordDto, {
        ...base,
        newPassword: 'weak',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateMarketingUserDto', () => {
    it('accepts an empty patch', async () => {
      expect(await validateDto(UpdateMarketingUserDto, {})).toEqual([]);
    });

    it('accepts a blank password (means unchanged → undefined)', async () => {
      expect(
        await validateDto(UpdateMarketingUserDto, { password: '' }),
      ).toEqual([]);
    });

    it('rejects a weak password', async () => {
      const msgs = await validateDto(UpdateMarketingUserDto, {
        password: 'weak',
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects password > 128', async () => {
      const msgs = await validateDto(UpdateMarketingUserDto, {
        password: 'Aa1' + 'b'.repeat(126),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  describe('CreateLeadDto', () => {
    const base = {
      businessName: 'Acme Coffee',
      contactPerson: 'Alice',
      businessType: 'CAFE',
      source: LeadSource.WEBSITE,
    };

    it('accepts a typical lead', async () => {
      expect(await validateDto(CreateLeadDto, base)).toEqual([]);
    });

    it('rejects businessName > 255', async () => {
      const msgs = await validateDto(CreateLeadDto, {
        ...base,
        businessName: 'a'.repeat(256),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects notes > 2000', async () => {
      const msgs = await validateDto(CreateLeadDto, {
        ...base,
        notes: 'a'.repeat(2001),
      });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  /**
   * Public booking surface (no auth): the untrusted reserve body is validated +
   * length-capped at the edge so a forged request can't carry a malformed
   * timestamp/email or oversize name into the booking service.
   */
  describe('BookSlotDto (public, untrusted)', () => {
    const base = {
      start: '2026-07-01T10:00:00.000Z',
      name: 'Alice',
      email: 'alice@example.com',
      phone: '+90 555 111 22 33',
    };

    it('accepts a valid reservation', async () => {
      expect(await validateDto(BookSlotDto, base)).toEqual([]);
    });

    it('accepts the minimal shape (start + name only)', async () => {
      expect(await validateDto(BookSlotDto, { start: base.start, name: 'Bob' })).toEqual([]);
    });

    it('rejects a non-ISO start', async () => {
      const msgs = await validateDto(BookSlotDto, { ...base, start: 'next tuesday' });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects a malformed email', async () => {
      const msgs = await validateDto(BookSlotDto, { ...base, email: 'not-an-email' });
      expect(msgs.length).toBeGreaterThan(0);
    });

    it('rejects an oversize name (> 120)', async () => {
      const msgs = await validateDto(BookSlotDto, { ...base, name: 'a'.repeat(121) });
      expect(msgs.length).toBeGreaterThan(0);
    });
  });
});
