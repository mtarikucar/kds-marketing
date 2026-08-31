// `EXTERNAL_REF_PATTERN` lives in a class-validator DTO, so importing the
// contract pulls in decorator metadata. The worker spec gets this for free
// via @nestjs/common; a spec that only touches the pure functions does not.
import 'reflect-metadata';
import { ResearchJob } from './research-job.service';
import {
  RESEARCH_SYSTEM_PROMPT,
  buildResearchBrief,
  researchBatchCap,
  researchTargetVolume,
  validateResearchCandidates,
} from './research-contract';

const JOB: ResearchJob = {
  workspaceId: 'ws1',
  workspaceSlug: 'acme',
  productName: 'Jeeta',
  productUrl: 'https://jeeta.test',
  productDescription: 'CRM for salons',
  defaultLanguage: 'tr',
  profile: {
    id: 'p1',
    name: 'Salons İzmir',
    icpDescription: 'Busy salons with poor booking',
    productPitch: 'Randevu kaosunu bitir',
    geo: { country: 'TR', cities: ['İzmir'] },
    language: 'tr',
    businessTypes: ['SALON'],
    exclusions: 'zincir kuaförler',
    lastRunAt: null,
  },
  remainingToday: 20,
  maxBatchSize: 50,
};

const GOOD = {
  externalRef: 'phone:+905551112233',
  businessName: 'Cafe X',
  businessType: 'CAFE',
  painPoint: 'Slow booking, angry reviews',
  evidence: 'https://maps.example/x — "waited 40 min"',
  pitch: 'Merhaba! Randevu...',
};

/**
 * The research CONTRACT: the instruction that goes out and the shape that is
 * accepted back.
 *
 * This module exists for one reason. There are now TWO drainers of the
 * research queue — the in-process worker on the platform's Anthropic key, and
 * the owner's own Claude over MCP — and the whole point of the MCP lane is
 * that the RESULT is the same. If each side wrote its own brief, quality would
 * silently become a function of which lane a workspace happened to be on, and
 * the difference would show up as "the MCP mode finds worse leads" months
 * later with no way to attribute it. One instruction, one validator, both
 * lanes.
 */
describe('research contract — one instruction and one validator for both lanes', () => {
  describe('the brief', () => {
    it('carries every hard filter the profile declares', () => {
      const brief = buildResearchBrief(JOB, null);

      expect(brief).toContain('Busy salons with poor booking'); // the ICP itself
      expect(brief).toContain('GEO (hard filter)');
      expect(brief).toContain('İzmir');
      expect(brief).toContain('BUSINESS TYPES (hard filter): SALON');
      expect(brief).toContain('EXCLUSIONS (hard filter): zincir kuaförler');
      expect(brief).toContain('LANGUAGE for painPoint/evidence/pitch: tr');
      expect(brief).toContain('PITCH ANGLE: Randevu kaosunu bitir');
      expect(brief).toContain('PRODUCT: Jeeta (https://jeeta.test)');
      expect(brief).toContain('WHAT IT DOES: CRM for salons');
    });

    it('includes the brand block only when there is one', () => {
      expect(buildResearchBrief(JOB, 'Brand: Acme\nWe sell X.')).toContain('BRAND CONTEXT: Brand: Acme');
      expect(buildResearchBrief(JOB, null)).not.toContain('BRAND CONTEXT');
    });

    it('states the disqualifiers and the externalRef key in the system prompt', () => {
      // These are the lines that separate an evidence-backed candidate from a
      // plausible-sounding one, and the dedup key that stops the same business
      // being researched and paid for every night. They are quality-bearing,
      // so they must live on the SERVER side of the wire — never in whatever
      // sentence the owner happened to type into their scheduled task.
      expect(RESEARCH_SYSTEM_PROMPT).toContain('HARD DISQUALIFIERS');
      expect(RESEARCH_SYSTEM_PROMPT).toContain('no reachable contact');
      expect(RESEARCH_SYSTEM_PROMPT).toContain('externalRef is the cross-day dedup key');
    });
  });

  describe('target volume and batch cap', () => {
    it('asks for no more than the workspace can actually accept today', () => {
      expect(researchTargetVolume({ ...JOB, remainingToday: 3 })).toBe(3);
      expect(researchBatchCap({ ...JOB, remainingToday: 3 })).toBe(13); // +10 headroom, under maxBatchSize
    });

    it('falls back to the batch size when the daily quota is unlimited', () => {
      expect(researchTargetVolume({ ...JOB, remainingToday: -1 })).toBe(50);
      expect(researchBatchCap({ ...JOB, remainingToday: -1 })).toBe(50);
    });

    it('never lets a huge remaining quota exceed the batch size', () => {
      expect(researchTargetVolume({ ...JOB, remainingToday: 9999 })).toBe(20);
      expect(researchBatchCap({ ...JOB, remainingToday: 9999 })).toBe(50);
    });
  });

  describe('the validator', () => {
    it('keeps a well-formed candidate and drops a malformed one', () => {
      const out = validateResearchCandidates([
        GOOD,
        { externalRef: 'not-a-ref', businessName: '', businessType: 'CAFE', painPoint: '', evidence: '', pitch: '' },
        null,
        'nonsense',
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ externalRef: 'phone:+905551112233', businessName: 'Cafe X', priority: 'MEDIUM' });
    });

    it('recovers the contact detail the ref already carries', () => {
      const [phone] = validateResearchCandidates([GOOD]);
      expect(phone.phone).toBe('+905551112233');

      const [site] = validateResearchCandidates([{ ...GOOD, externalRef: 'domain:louise.com.tr' }]);
      expect(site.website).toBe('https://louise.com.tr');

      const [ig] = validateResearchCandidates([{ ...GOOD, externalRef: 'instagram:@louise' }]);
      expect(ig.instagram).toBe('@louise');
    });

    it('prefers an explicit field over the ref fallback', () => {
      const [c] = validateResearchCandidates([{ ...GOOD, phone: '+905559998877' }]);
      expect(c.phone).toBe('+905559998877');
    });

    it('drops a score outside 0-100 rather than rescaling a guess', () => {
      expect(validateResearchCandidates([{ ...GOOD, score: 58 }])[0].score).toBe(58);
      expect(validateResearchCandidates([{ ...GOOD, score: 0.82 }])[0].score).toBe(0.82);
      expect(validateResearchCandidates([{ ...GOOD, score: 101 }])[0].score).toBeUndefined();
      expect(validateResearchCandidates([{ ...GOOD, score: null }])[0].score).toBeUndefined();
      expect(validateResearchCandidates([{ ...GOOD, score: '' }])[0].score).toBeUndefined();
    });

    it('constrains stage and priority to the vocabulary the review queue ranks on', () => {
      const [ok] = validateResearchCandidates([{ ...GOOD, stage: 'GROWING', priority: 'URGENT' }]);
      expect(ok).toMatchObject({ stage: 'GROWING', priority: 'URGENT' });

      const [junk] = validateResearchCandidates([{ ...GOOD, stage: 'THRIVING', priority: 'SUPER' }]);
      expect(junk.stage).toBeUndefined();
      expect(junk.priority).toBe('MEDIUM');
    });
  });
});

/**
 * `validateResearchCandidates` is the only thing standing between the model's JSON and the
 * database. `stage` and `priority` were always checked against their enums;
 * `score` was accepted as any finite number, and the review queue sorted on it.
 * Runs came back on 0-100, 0-10 and 0-1 scales, so the ranking was noise.
 */
describe('research contract — score validation', () => {
  const base = {
    externalRef: 'phone:+905551112233',
    businessName: 'Cafe X',
    businessType: 'CAFE',
    painPoint: 'p',
    evidence: 'e',
    pitch: 'pi',
  };
  const validate = (score: unknown) => validateResearchCandidates([{ ...base, score }])[0];

  it('keeps an in-range score', () => {
    expect(validate(58).score).toBe(58);
    expect(validate(0).score).toBe(0);
    expect(validate(100).score).toBe(100);
  });

  it('drops a score outside 0-100 instead of storing it', () => {
    // Rescaling would be a guess, and a guess here invents a ranking.
    expect(validate(150).score).toBeUndefined();
    expect(validate(-5).score).toBeUndefined();
  });

  it('drops a non-numeric score', () => {
    expect(validate('high').score).toBeUndefined();
    expect(validate(null).score).toBeUndefined();
    expect(validate(undefined).score).toBeUndefined();
  });

  it('still accepts the candidate when the score is unusable', () => {
    // The score is an ordering hint; losing it must not lose the prospect.
    expect(validate(999).businessName).toBe('Cafe X');
  });
});

/**
 * The externalRef is a contact detail, not just a dedup key.
 *
 * Three of its five forms ARE the contact: `phone:`, `instagram:`, `domain:`.
 * The model fills the ref reliably — it is required — and the matching field
 * only sometimes. Measured on the live database: 33 of 301 leads carrying a
 * `phone:` ref had a NULL phone, so a number the researcher had already found
 * and paid for sat in the key and nowhere the product could use it. Those leads
 * read as uncontactable.
 */
describe('research contract — contact recovery from externalRef', () => {
  const base = {
    businessName: 'Cafe X',
    businessType: 'CAFE',
    painPoint: 'p',
    evidence: 'e',
    pitch: 'pi',
  };
  const validate = (extra: Record<string, unknown>) => validateResearchCandidates([{ ...base, ...extra }])[0];

  it('recovers a phone from a phone: ref when the field is empty', () => {
    const c = validate({ externalRef: 'phone:+905551112233' });
    expect(c.phone).toBe('+905551112233');
  });

  it('recovers an instagram handle and turns a domain ref into a usable url', () => {
    expect(validate({ externalRef: 'instagram:@cafex' }).instagram).toBe('@cafex');
    expect(validate({ externalRef: 'domain:cafex.com.tr' }).website).toBe('https://cafex.com.tr');
  });

  it('never overrides a field the model actually supplied', () => {
    const c = validate({ externalRef: 'phone:+905551112233', phone: '+902121112233' });
    // The ref is only a fallback; an explicit field is the better evidence.
    expect(c.phone).toBe('+902121112233');
  });

  it('yields nothing for refs that carry no contact', () => {
    expect(validate({ externalRef: 'hash:' + 'a'.repeat(40) }).phone).toBeUndefined();
    expect(validate({ externalRef: 'google:' + 'a'.repeat(21) }).phone).toBeUndefined();
  });
});
