import { R2StorageService } from './r2-storage.service';

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteObjectsCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

/**
 * Shared object storage (moved out of social-planner/ so both social-planner
 * AND telephony — NetGSM Phase 4 recording ingest — can import the same
 * client without one feature owning the other's storage helper). Behavior is
 * unchanged from the pre-move implementation; this spec is the shared
 * component's own direct unit coverage (previously only exercised indirectly
 * through consumer fakes in social-planner/media-gen/brand-kit specs).
 */
describe('R2StorageService', () => {
  const ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    sendMock.mockReset();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function configure() {
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_BUCKET = 'bucket';
    process.env.R2_PUBLIC_BASE_URL = 'https://cdn.example.com/';
  }

  describe('isConfigured', () => {
    it('is false when any R2_* env var is missing', () => {
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.R2_BUCKET;
      delete process.env.R2_PUBLIC_BASE_URL;
      expect(new R2StorageService().isConfigured()).toBe(false);
    });

    it('is true when every R2_* env var is set', () => {
      configure();
      expect(new R2StorageService().isConfigured()).toBe(true);
    });
  });

  describe('upload', () => {
    it('throws when not configured (no PutObjectCommand sent)', async () => {
      delete process.env.R2_ACCOUNT_ID;
      const svc = new R2StorageService();
      await expect(
        svc.upload('ws-1', { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 }),
      ).rejects.toThrow('R2 storage is not configured');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('uploads under social/<workspaceId>/ with the mime-mapped extension and returns url+key+mime', async () => {
      configure();
      sendMock.mockResolvedValue({});
      const svc = new R2StorageService();
      const res = await svc.upload('ws-1', { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 });
      expect(res.mime).toBe('image/png');
      expect(res.key).toMatch(/^social\/ws-1\/[0-9a-f-]+\.png$/);
      expect(res.url).toBe(`https://cdn.example.com/${res.key}`); // trailing slash on base stripped
      const sentInput = sendMock.mock.calls[0][0].input;
      expect(sentInput).toMatchObject({ Bucket: 'bucket', Key: res.key, ContentType: 'image/png' });
    });

    it('falls back to the original filename extension for an unmapped mime type', async () => {
      configure();
      sendMock.mockResolvedValue({});
      const svc = new R2StorageService();
      const res = await svc.upload('ws-1', {
        mimetype: 'application/octet-stream', originalname: 'clip.avi', buffer: Buffer.from('x'), size: 1,
      });
      expect(res.key).toMatch(/\.avi$/);
    });

    it('falls back to "bin" when neither the mime map nor the filename yields a usable extension', async () => {
      configure();
      sendMock.mockResolvedValue({});
      const svc = new R2StorageService();
      const res = await svc.upload('ws-1', { mimetype: 'application/octet-stream', buffer: Buffer.from('x'), size: 1 });
      expect(res.key).toMatch(/\.bin$/);
    });
  });

  describe('uploadToKey', () => {
    it('throws when not configured (no PutObjectCommand sent)', async () => {
      delete process.env.R2_ACCOUNT_ID;
      const svc = new R2StorageService();
      await expect(
        svc.uploadToKey('netgsm-recordings/ws-1/call-1.mp3', { mimetype: 'audio/mpeg', buffer: Buffer.from('x'), size: 1 }),
      ).rejects.toThrow('R2 storage is not configured');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('uploads to the EXACT caller-supplied key (no derived scheme) and returns url+key+mime', async () => {
      configure();
      sendMock.mockResolvedValue({});
      const svc = new R2StorageService();
      const key = 'netgsm-recordings/ws-1/call-1.mp3';
      const res = await svc.uploadToKey(key, { mimetype: 'audio/mpeg', buffer: Buffer.from('audio-bytes'), size: 11 });
      expect(res.key).toBe(key);
      expect(res.mime).toBe('audio/mpeg');
      expect(res.url).toBe(`https://cdn.example.com/${key}`);
      const sentInput = sendMock.mock.calls[0][0].input;
      expect(sentInput).toMatchObject({ Bucket: 'bucket', Key: key, ContentType: 'audio/mpeg' });
    });

    it('does not affect upload()\'s random-key scheme (social-planner behavior untouched)', async () => {
      configure();
      sendMock.mockResolvedValue({});
      const svc = new R2StorageService();
      const res = await svc.upload('ws-1', { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 });
      expect(res.key).toMatch(/^social\/ws-1\/[0-9a-f-]+\.png$/);
    });
  });

  describe('urlForKey', () => {
    it('joins the public base + key (trailing slash on base stripped)', () => {
      configure();
      const svc = new R2StorageService();
      expect(svc.urlForKey('netgsm-recordings/ws-1/call-1.mp3')).toBe(
        'https://cdn.example.com/netgsm-recordings/ws-1/call-1.mp3',
      );
    });
  });

  // HIGH fix round 1 (NetGSM Phase 4 Task 3) — RecordingProxyController streams
  // through this instead of ever handing the browser R2's public URL.
  describe('getObjectStream', () => {
    it('throws when not configured (no GetObjectCommand sent)', async () => {
      delete process.env.R2_ACCOUNT_ID;
      const svc = new R2StorageService();
      await expect(svc.getObjectStream('netgsm-recordings/ws-1/call-1.mp3')).rejects.toThrow(
        'R2 storage is not configured',
      );
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('returns the body stream + content-type/length for an existing object', async () => {
      configure();
      const fakeBody = { pipe: jest.fn() };
      sendMock.mockResolvedValue({ Body: fakeBody, ContentType: 'audio/mpeg', ContentLength: 12345 });
      const svc = new R2StorageService();
      const key = 'netgsm-recordings/ws-1/call-1.mp3';

      const res = await svc.getObjectStream(key);

      expect(res.body).toBe(fakeBody);
      expect(res.contentType).toBe('audio/mpeg');
      expect(res.contentLength).toBe(12345);
      const sentInput = sendMock.mock.calls[0][0].input;
      expect(sentInput).toEqual({ Bucket: 'bucket', Key: key });
    });

    it('throws when the object has no body (treated as not-found by callers)', async () => {
      configure();
      sendMock.mockResolvedValue({});
      const svc = new R2StorageService();
      await expect(svc.getObjectStream('missing-key.mp3')).rejects.toThrow('has no body');
    });
  });

  describe('deleteKeys', () => {
    it('no-ops (never calls send) when the key list is empty', async () => {
      configure();
      await new R2StorageService().deleteKeys([]);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('no-ops when R2 is not configured, even with keys', async () => {
      delete process.env.R2_BUCKET;
      await new R2StorageService().deleteKeys(['social/ws/a.png']);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('sends a DeleteObjectsCommand with the filtered keys when configured', async () => {
      configure();
      sendMock.mockResolvedValue({});
      await new R2StorageService().deleteKeys(['social/ws/a.png', '', 'social/ws/b.mp4']);
      const sentInput = sendMock.mock.calls[0][0].input;
      expect(sentInput.Bucket).toBe('bucket');
      expect(sentInput.Delete.Objects).toEqual([{ Key: 'social/ws/a.png' }, { Key: 'social/ws/b.mp4' }]);
    });

    it('swallows a delete failure (best-effort cleanup — never throws)', async () => {
      configure();
      sendMock.mockRejectedValue(new Error('network down'));
      await expect(new R2StorageService().deleteKeys(['social/ws/a.png'])).resolves.toBeUndefined();
    });
  });
});
