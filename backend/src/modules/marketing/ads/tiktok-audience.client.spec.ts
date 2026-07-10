// ── safeFetch mock (the seam the TikTok write client transports over) ────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  uploadTiktokAudienceFile,
  createTiktokCustomAudience,
  appendTiktokAudienceUsers,
} from './tiktok-audience.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

beforeEach(() => mockSafeFetch.mockReset());

describe('uploadTiktokAudienceFile', () => {
  it('uploads a multipart SHA256 file and returns data.file_path', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: { file_path: '/dmp/aud.txt' } }));
    const out = await uploadTiktokAudienceFile('tok', 'adv_1', 'EMAIL_SHA256', ['aaa', 'bbb']);
    expect(out).toEqual({ ok: true, filePath: '/dmp/aud.txt' });

    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toContain('/open_api/v1.3/dmp/custom_audience/file/upload/');
    expect(opts.headers['Access-Token']).toBe('tok');
    // multipart: fetch derives the Content-Type + boundary from the FormData body,
    // so the client must NOT set Content-Type itself.
    expect(opts.headers['Content-Type']).toBeUndefined();

    const form = opts.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('advertiser_id')).toBe('adv_1');
    expect(form.get('calculate_type')).toBe('EMAIL_SHA256');
    expect(typeof form.get('file_signature')).toBe('string');
    expect(form.get('file')).toBeTruthy();
  });

  it('surfaces a token-invalid code on upload as isAuthError', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40105, message: 'access token expired' }));
    const out = await uploadTiktokAudienceFile('tok', 'adv_1', 'EMAIL_SHA256', ['a']);
    expect(out.ok).toBe(false);
    expect(out.isAuthError).toBe(true);
    expect(out.error).toContain('40105');
  });
});

describe('createTiktokCustomAudience', () => {
  it('creates a custom audience and returns the custom_audience_id', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: { custom_audience_id: 'ca_77' } }));
    const out = await createTiktokCustomAudience('tok', 'adv_1', {
      name: 'CRM: VIP',
      filePaths: ['/dmp/f1'],
      calculateType: 'EMAIL_SHA256',
    });
    expect(out).toEqual({ ok: true, id: 'ca_77' });

    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toContain('/open_api/v1.3/dmp/custom_audience/create/');
    expect(opts.headers['Access-Token']).toBe('tok');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      advertiser_id: 'adv_1',
      custom_audience_name: 'CRM: VIP',
      file_paths: ['/dmp/f1'],
      calculate_type: 'EMAIL_SHA256',
    });
  });

  it('surfaces a non-zero code as a non-auth {ok:false,error}', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40100, message: 'bad request' }));
    const out = await createTiktokCustomAudience('tok', 'adv_1', {
      name: 'x',
      filePaths: ['/f'],
      calculateType: 'EMAIL_SHA256',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('40100');
    expect(out.isAuthError).toBe(false);
  });
});

describe('appendTiktokAudienceUsers', () => {
  it('appends file handles to an existing audience with action APPEND', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: {} }));
    const out = await appendTiktokAudienceUsers('tok', 'adv_1', {
      customAudienceId: 'ca_77',
      filePaths: ['/dmp/f2'],
      calculateType: 'EMAIL_SHA256',
    });
    expect(out).toEqual({ ok: true, id: 'ca_77' });

    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toContain('/open_api/v1.3/dmp/custom_audience/update/');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      advertiser_id: 'adv_1',
      custom_audience_id: 'ca_77',
      action: 'APPEND',
      file_paths: ['/dmp/f2'],
      calculate_type: 'EMAIL_SHA256',
    });
  });

  it('flags a token-invalid code as isAuthError (drives reauth)', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40105, message: 'access token invalid' }));
    const out = await appendTiktokAudienceUsers('tok', 'adv_1', {
      customAudienceId: 'ca',
      filePaths: ['/f'],
      calculateType: 'EMAIL_SHA256',
    });
    expect(out.ok).toBe(false);
    expect(out.isAuthError).toBe(true);
  });
});
