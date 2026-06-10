jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockRejectedValue(new Error('missing')),
    },
  };
});

import { promises as fs } from 'fs';
import { BadRequestException } from '@nestjs/common';
import { BrandingService } from './branding.service';
import { SiteRendererService } from '../sites/site-renderer.service';

/**
 * White-label branding: validated set, logo upload (mime/size guarded, written
 * under UPLOADS_DIR), path-traversal-safe serving, and the renderer applying
 * the workspace accent + logo header to public pages.
 */
describe('BrandingService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: BrandingService;

  beforeEach(() => {
    prisma = { workspaceBranding: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) } };
    const config = { get: jest.fn().mockReturnValue('/tmp/uploads-test') };
    svc = new BrandingService(prisma as any, config as any);
  });

  it('get returns nulls when nothing is set', async () => {
    await expect(svc.get(WS)).resolves.toEqual({ brandName: null, accentColor: null, logoUrl: null });
  });

  it('set ignores an invalid accent color', async () => {
    prisma.workspaceBranding.findUnique.mockResolvedValue({ brandName: 'Acme', accentColor: null, logoUrl: null });
    await svc.set(WS, { brandName: 'Acme', accentColor: 'not-a-color' });
    const upsertArgs = prisma.workspaceBranding.upsert.mock.calls[0][0];
    expect(upsertArgs.update.accentColor).toBeUndefined(); // invalid → not written
  });

  it('saveLogo rejects a non-image mime', async () => {
    await expect(svc.saveLogo(WS, { mimetype: 'application/zip', buffer: Buffer.from('x'), size: 10 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saveLogo rejects an oversize file', async () => {
    await expect(svc.saveLogo(WS, { mimetype: 'image/png', buffer: Buffer.alloc(10), size: 2_000_000 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saveLogo writes the file + stores a public logo URL', async () => {
    const res = await svc.saveLogo(WS, { mimetype: 'image/png', buffer: Buffer.from('img'), size: 3 });
    expect(fs.writeFile).toHaveBeenCalled();
    const logoUrl = prisma.workspaceBranding.upsert.mock.calls[0][0].create.logoUrl;
    expect(logoUrl).toMatch(/^\/api\/public\/uploads\/ws-1-[a-f0-9]+\.png$/);
  });

  it('readUpload refuses path traversal', async () => {
    await expect(svc.readUpload('../../etc/passwd')).resolves.toBeNull();
  });
});

describe('SiteRenderer branding', () => {
  it('renders a logo + brand header and uses the workspace accent as fallback', () => {
    const html = new SiteRendererService().render(
      { title: 'T', blocks: [{ type: 'hero', heading: 'Hi' }] },
      new Map(),
      'https://m.example',
      { brandName: 'Acme', accentColor: '#ff0000', logoUrl: '/api/public/uploads/x.png' },
    );
    expect(html).toContain('Acme');
    expect(html).toContain('/api/public/uploads/x.png');
    expect(html).toContain('#ff0000');
  });
});
