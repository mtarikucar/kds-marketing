import {
  analyzeOnPage,
  analyzePageSpeed,
  skippedPageSpeed,
  overallScore,
} from './audit-checks';

describe('audit-checks (pure scoring)', () => {
  describe('analyzeOnPage', () => {
    it('scores a well-formed HTTPS page highly', () => {
      const html =
        `<html><head><title>Acme Coffee — Specialty Roasters in Izmir</title>` +
        `<meta name="description" content="${'x'.repeat(80)}">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
        `<body><h1>Welcome</h1></body></html>`;
      const s = analyzeOnPage(html, 'https://acme.example/');
      expect(s.key).toBe('onpage');
      expect(s.score).toBeGreaterThanOrEqual(80);
      expect(s.status).toBe('good');
    });

    it('penalises a bare HTTP page with no title/meta/viewport', () => {
      const s = analyzeOnPage('<html><body><p>hi</p></body></html>', 'http://x.example/');
      expect(s.score).toBeLessThan(50);
      expect(s.status).toBe('poor');
      expect(s.findings.join(' ')).toMatch(/HTTPS/i);
      expect(s.findings.join(' ')).toMatch(/title/i);
    });

    it('flags multiple H1s but does not zero the section', () => {
      const html = `<title>${'t'.repeat(20)}</title><h1>a</h1><h1>b</h1>`;
      const s = analyzeOnPage(html, 'https://x.example/');
      expect(s.findings.join(' ')).toMatch(/2 H1/);
    });
  });

  describe('analyzePageSpeed', () => {
    it('converts Lighthouse 0–1 category scores into 0–100 sections', () => {
      const psi = {
        lighthouseResult: {
          categories: {
            performance: { score: 0.42 },
            seo: { score: 0.9 },
            accessibility: { score: 1 },
            'best-practices': { score: null },
          },
        },
      };
      const out = analyzePageSpeed(psi);
      const perf = out.find((s) => s.key === 'performance')!;
      expect(perf.score).toBe(42);
      expect(perf.status).toBe('poor');
      expect(out.find((s) => s.key === 'seo')!.score).toBe(90);
      expect(out.find((s) => s.key === 'accessibility')!.score).toBe(100);
      // a null category score is reported as skipped, not 0
      expect(out.find((s) => s.key === 'best-practices')!.score).toBeNull();
      expect(out.find((s) => s.key === 'best-practices')!.status).toBe('skipped');
    });

    it('tolerates a malformed PSI body (no categories)', () => {
      const out = analyzePageSpeed({});
      expect(out.every((s) => s.score === null && s.status === 'skipped')).toBe(true);
    });
  });

  describe('overallScore', () => {
    it('averages only the sections that produced a number', () => {
      const score = overallScore([
        { key: 'a', label: 'A', score: 80, status: 'good', findings: [] },
        { key: 'b', label: 'B', score: 40, status: 'poor', findings: [] },
        skippedPageSpeed(), // null → ignored
      ]);
      expect(score).toBe(60);
    });

    it('is 0 when nothing could be scored', () => {
      expect(overallScore([skippedPageSpeed()])).toBe(0);
    });
  });
});
