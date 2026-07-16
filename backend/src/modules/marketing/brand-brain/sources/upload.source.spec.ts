import { Readable } from 'stream';
import { UploadBrandSource } from './upload.source';

function makeSvc(r2: Partial<{ isConfigured: () => boolean; urlForKey: jest.Mock; getObjectStream: jest.Mock }>) {
  const provider: any = {
    isConfigured: () => true,
    urlForKey: jest.fn((key: string) => `https://cdn.example/${key}`),
    getObjectStream: jest.fn(),
    ...r2,
  };
  return { svc: new UploadBrandSource(provider), provider };
}

describe('UploadBrandSource', () => {
  it('inert when R2 is unconfigured — never calls urlForKey/getObjectStream', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => false });
    const result = await svc.collect('ws-1', { uploadKeys: ['logo.png'] });
    expect(result).toEqual({ source: 'uploads', status: 'inert', raw: null });
    expect(provider.urlForKey).not.toHaveBeenCalled();
    expect(provider.getObjectStream).not.toHaveBeenCalled();
  });

  it('inert when uploadKeys is empty/missing (even if configured)', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => true });
    const result = await svc.collect('ws-1', {});
    expect(result).toEqual({ source: 'uploads', status: 'inert', raw: null });
    expect(provider.urlForKey).not.toHaveBeenCalled();
  });

  it('ok: classifies image keys as BrandKit-candidate URLs via urlForKey', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => true });
    const result = await svc.collect('ws-1', { uploadKeys: ['brand/logo.png'] });
    expect(result.status).toBe('ok');
    expect((result.raw as any).images).toEqual([{ key: 'brand/logo.png', url: 'https://cdn.example/brand/logo.png' }]);
    expect((result.raw as any).docs).toEqual([]);
    expect(provider.getObjectStream).not.toHaveBeenCalled();
  });

  it('ok: reads text-ish keys via getObjectStream and captures their content', async () => {
    const { svc, provider } = makeSvc({
      isConfigured: () => true,
      getObjectStream: jest.fn().mockResolvedValue({ body: Readable.from(['hello']) }),
    });
    const result = await svc.collect('ws-1', { uploadKeys: ['notes/about.txt'] });
    expect(result.status).toBe('ok');
    expect((result.raw as any).docs).toEqual([{ key: 'notes/about.txt', text: 'hello' }]);
    expect(provider.getObjectStream).toHaveBeenCalledWith('notes/about.txt');
  });

  it('ok: binary/other keys (e.g. PDF) are recorded with a deferred note, no R2 read attempted', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => true });
    const result = await svc.collect('ws-1', { uploadKeys: ['docs/menu.pdf'] });
    expect(result.status).toBe('ok');
    expect((result.raw as any).docs).toEqual([
      { key: 'docs/menu.pdf', text: '', note: 'binary — text extraction deferred' },
    ]);
    expect(provider.getObjectStream).not.toHaveBeenCalled();
  });

  it('error isolation: one key failing to read does not fail the whole source', async () => {
    const { svc } = makeSvc({
      isConfigured: () => true,
      getObjectStream: jest
        .fn()
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ body: Readable.from(['ok text']) }),
    });
    const result = await svc.collect('ws-1', { uploadKeys: ['notes/broken.txt', 'notes/fine.md'] });
    expect(result.status).toBe('ok');
    expect((result.raw as any).docs).toEqual([
      { key: 'notes/broken.txt', text: '', note: 'read failed' },
      { key: 'notes/fine.md', text: 'ok text' },
    ]);
  });
});
