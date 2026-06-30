import { PublicDocumentController } from './public-document.controller';

/**
 * The e-signature page disables Sign/Decline before POSTing. They must come back
 * on EVERY non-confirming outcome — an already-resolved document (conflict) or a
 * network/non-JSON failure — and success must only be declared on a real
 * SIGNED/DECLINED status. Regression guard for the missing fetch .catch +
 * response-shape check.
 */
describe('PublicDocumentController.page', () => {
  function makeRes() {
    const res: any = { _html: '', _status: 200 };
    res.status = (c: number) => {
      res._status = c;
      return res;
    };
    res.type = () => res;
    res.send = (h: string) => {
      res._html = h;
      return res;
    };
    return res;
  }

  function makeCtrl(view: any) {
    const documents = { publicView: jest.fn().mockResolvedValue(view) };
    return { ctrl: new PublicDocumentController(documents as any), documents };
  }

  const OPEN_DOC = {
    title: 'NDA',
    bodySnapshot: 'Terms…',
    consentStatement: 'I agree',
    status: 'SENT',
    signerName: null,
    signedAt: null,
  };

  it('renders the Sign/Decline form for an unsigned document', async () => {
    const { ctrl } = makeCtrl(OPEN_DOC);
    const res = makeRes();
    await ctrl.page('d_token', res);
    expect(res._html).toContain('id="ok"');
    expect(res._html).toContain('id="no"');
    expect(res._html).toContain('NDA');
  });

  it('re-enables both buttons on a failed/non-confirming sign or decline', async () => {
    const { ctrl } = makeCtrl(OPEN_DOC);
    const res = makeRes();
    await ctrl.page('d_token', res);
    // Both flows need a .catch, and the recovery re-enables both buttons.
    expect((res._html.match(/\.catch\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(res._html).toMatch(/ok\.disabled\s*=\s*false/);
    expect(res._html).toMatch(/no\.disabled\s*=\s*false/);
    // Success is gated on the real status (decline no longer blindly shows it).
    expect(res._html).toContain("d.status==='SIGNED'");
    expect(res._html).toContain("d.status==='DECLINED'");
  });

  it('shows the signed banner and no form once signed', async () => {
    const { ctrl } = makeCtrl({ ...OPEN_DOC, status: 'SIGNED', signerName: 'Jane', signedAt: '2026-06-01T00:00:00Z' });
    const res = makeRes();
    await ctrl.page('d_token', res);
    expect(res._html).toContain('Signed by Jane');
    expect(res._html).not.toContain('id="ok"');
  });

  it('404s a missing document without throwing', async () => {
    const { ctrl, documents } = makeCtrl(OPEN_DOC);
    documents.publicView.mockRejectedValueOnce(new Error('not found'));
    const res = makeRes();
    await ctrl.page('bad', res);
    expect(res._status).toBe(404);
  });
});
