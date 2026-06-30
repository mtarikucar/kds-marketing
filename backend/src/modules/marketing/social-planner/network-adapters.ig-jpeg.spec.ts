import { igImageNeedsJpeg } from './network-adapters';

describe('igImageNeedsJpeg', () => {
  it('flags a PNG image (Instagram rejects non-JPEG → "Media ID is not available")', () => {
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.png', mime: 'image/png' })).toBe(true);
  });

  it('passes through a JPEG (mime)', () => {
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.jpg', mime: 'image/jpeg' })).toBe(false);
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.jpg', mime: 'image/jpg' })).toBe(false);
  });

  it('flags WebP/GIF images', () => {
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.webp', mime: 'image/webp' })).toBe(true);
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.gif', mime: 'image/gif' })).toBe(true);
  });

  it('never flags a video item', () => {
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.mp4', mime: 'video/mp4' })).toBe(false);
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/clip.mov' })).toBe(false);
  });

  it('falls back to the URL extension when mime is absent', () => {
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.png' })).toBe(true);
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.jpg' })).toBe(false);
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/x.jpeg?v=2' })).toBe(false);
    // unknown extension with no mime → treat as non-JPEG (safer to transcode)
    expect(igImageNeedsJpeg({ url: 'https://r2.dev/a/image' })).toBe(true);
  });
});
