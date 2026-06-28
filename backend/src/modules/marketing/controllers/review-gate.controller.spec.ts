import { ReviewGateController } from './review-gate.controller';

/**
 * The rating-gate page POSTs the rating, then either redirects (≥4★ → public
 * review site) or shows a thank-you (<4★ private feedback). A transient POST
 * failure must NOT silently drop the submission — the customer needs a retry
 * cue, or their review/feedback is lost with no notice.
 */
describe('ReviewGateController.page', () => {
  function makeRes() {
    const res: any = { _html: '' };
    res.type = () => res;
    res.send = (h: string) => {
      res._html = h;
      return res;
    };
    return res;
  }

  function html(token = 'rv_tok'): string {
    const ctrl = new ReviewGateController({} as any);
    const res = makeRes();
    ctrl.page(token, res);
    return res._html;
  }

  it('renders the star gate and POSTs to the token endpoint', () => {
    const out = html();
    expect(out).toContain('How was your experience');
    expect(out).toContain("method:'POST'");
    expect(out).toContain('/api/public/r/rv_tok');
  });

  it('handles a failed submission with a retry message (fetch has a .catch)', () => {
    const out = html();
    expect(out).toMatch(/\.catch\(/);
    // The recovery surfaces an error rather than silently dropping the review.
    expect(out).toContain('err.textContent');
  });

  it('escapes the token in the API path (no HTML/JS injection)', () => {
    const out = html('a"</script><b>');
    expect(out).not.toContain('</script><b>');
    expect(out).toContain('&quot;');
  });
});
