import { describe, it, expect } from 'vitest';
import privacyContent from './content/privacy';
import dataDeletionContent from './content/dataDeletion';
import type { LegalContent, LegalDoc } from './legalShared';
import footerSource from '../landing/LandingFooter.tsx?raw';
import en from '../../i18n/locales/en/marketing.json';
import tr from '../../i18n/locales/tr/marketing.json';

/**
 * The document-level contract the platform reviews are actually read against.
 *
 * Meta's App Review expects the privacy policy to describe **Platform Data**
 * handling by name; TikTok, Pinterest and LinkedIn reviews all ask for the
 * equivalent, plus a linkable "how do I get my data deleted" page. None of that
 * is enforceable by looking at one language: this file carries BOTH halves and a
 * section added to only one of them is the failure mode that ships.
 */

/** Every string in a doc, flattened — headings, paragraphs and bullets. */
function textOf(doc: LegalDoc): string {
  return [
    doc.title,
    doc.subtitle,
    ...doc.intro,
    ...doc.sections.flatMap((s) => [s.heading, ...(s.body ?? []), ...(s.items ?? [])]),
  ].join('\n');
}

const sectionIds = (doc: LegalDoc) => doc.sections.map((s) => s.id);

/** The networks the app connects to. Every one must be named. */
const NETWORKS = [
  /Facebook/i,
  /Instagram/i,
  /LinkedIn/i,
  /TikTok/i,
  /Pinterest/i,
  /Google Business Profile/i,
];

describe('privacy policy — platform data section (Meta App Review prerequisite)', () => {
  // The two halves of this document use LOCALISED anchor slugs by existing
  // convention (`veri-sorumlusu` vs `controller`), so identical id lists is the
  // wrong invariant — measured, not assumed. What must hold is that the halves
  // stay in STEP: same number of sections, and the platform-data section at the
  // same position in both (it keeps a shared `platform-data` anchor on purpose,
  // so a reviewer's deep link works in either language).
  it('keeps the Turkish and English halves in step, section for section', () => {
    const tr = sectionIds(privacyContent.tr);
    const en = sectionIds(privacyContent.en);
    expect(tr).toHaveLength(en.length);
    expect(tr.indexOf('platform-data')).toBe(en.indexOf('platform-data'));
    expect(new Set(tr).size).toBe(tr.length);
    expect(new Set(en).size).toBe(en.length);
  });

  for (const lang of ['tr', 'en'] as const) {
    describe(lang, () => {
      const doc = privacyContent[lang];

      it('carries a dedicated platform-data section', () => {
        expect(sectionIds(doc)).toContain('platform-data');
      });

      it('names every connected network', () => {
        const section = doc.sections.find((s) => s.id === 'platform-data')!;
        const text = [section.heading, ...(section.body ?? []), ...(section.items ?? [])].join('\n');
        for (const network of NETWORKS) expect(text).toMatch(network);
        // X (formerly Twitter) has a one-letter name — match it as a word.
        expect(text).toMatch(/\bX \(Twitter\)/);
      });

      it('states, per platform, what we receive / why / how long / how it is deleted', () => {
        const section = doc.sections.find((s) => s.id === 'platform-data')!;
        // One bullet per network, plus the retention + deletion statements.
        expect((section.items ?? []).length).toBeGreaterThanOrEqual(NETWORKS.length + 1);
        const text = [...(section.body ?? []), ...(section.items ?? [])].join('\n');
        expect(text).toMatch(lang === 'tr' ? /sakla/i : /retain|keep/i);
        expect(text).toMatch(lang === 'tr' ? /sil/i : /delet/i);
      });

      it('points the reader at the data-deletion page', () => {
        expect(textOf(doc)).toContain('/data-deletion');
      });
    });
  }
});

describe('data-deletion instructions page', () => {
  const content: LegalContent = dataDeletionContent;

  it('has the SAME section ids in Turkish and English', () => {
    expect(sectionIds(content.tr)).toEqual(sectionIds(content.en));
  });

  for (const lang of ['tr', 'en'] as const) {
    describe(lang, () => {
      const doc = content[lang];

      it('tells the reader HOW to ask (a concrete channel, not "contact us")', () => {
        expect(textOf(doc)).toContain('admin@jeetagrowth.com');
      });

      it('explains the in-platform route AND the platform-initiated one', () => {
        const ids = sectionIds(doc);
        expect(ids).toContain('how-to-request');
        expect(ids).toContain('platform-requests');
        expect(ids).toContain('what-gets-deleted');
        expect(ids).toContain('what-is-kept');
      });

      it('is honest that some records are legally retained rather than deleted', () => {
        const kept = doc.sections.find((s) => s.id === 'what-is-kept')!;
        const text = [kept.heading, ...(kept.body ?? []), ...(kept.items ?? [])].join('\n');
        expect(text).toMatch(lang === 'tr' ? /yasal|mevzuat/i : /legal|law/i);
      });

      it('tells the reader where to check a platform request by confirmation code', () => {
        expect(textOf(doc)).toContain('/data-deletion-status');
      });
    });
  }
});

describe('the data-deletion page is reachable from the site, not only from a console field', () => {
  it('the landing footer links to /data-deletion', () => {
    expect(footerSource).toContain("to: '/data-deletion'");
  });

  it('its label resolves in both first-class catalogues (not just the inline default)', () => {
    // The footer calls t('landing.footer.linkDataDeletion', 'Data deletion').
    // The inline default means a MISSING key renders English to a Turkish
    // visitor rather than a raw key — silent, and exactly what usedKeys.test.ts
    // was written about. So assert the catalogues, not the render.
    const path = (c: any) => c?.landing?.footer?.linkDataDeletion;
    expect(path(en)).toBeTruthy();
    expect(path(tr)).toBeTruthy();
    expect(path(tr)).not.toBe(path(en));
  });
});
