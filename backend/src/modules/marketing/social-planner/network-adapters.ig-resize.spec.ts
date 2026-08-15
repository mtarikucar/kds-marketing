import Jimp from 'jimp';
import * as metaUtil from '../../../common/util/meta-graph.util';
import * as fetchMod from '../../../common/util/safe-fetch';
import { R2StorageService } from '../../../common/storage/r2-storage.service';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { publishToNetwork } from './network-adapters';

jest.mock('../../../common/util/meta-graph.util', () => ({ metaGraphFetch: jest.fn() }));
jest.mock('../../../common/util/safe-fetch');

const metaFetch = metaUtil.metaGraphFetch as jest.Mock;
const safeFetch = fetchMod.safeFetch as jest.Mock;

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ok = (data: any) => ({ ok: true, status: 200, data, error: null });
const igAccount = () =>
  ({ id: 'a', network: 'INSTAGRAM', externalId: 'IG123', accessToken: sealSecret('TOK') }) as any;

/** A real JPEG of the given size, so Jimp reads genuine pixels. */
async function jpegOf(width: number, height: number): Promise<Buffer> {
  const img = await Jimp.create(width, height, 0x336699ff);
  return img.getBufferAsync(Jimp.MIME_JPEG);
}

/**
 * One publish, with every mock created and read inside this call.
 *
 * The mocks are deliberately NOT shared through `beforeEach`: `metaGraphFetch`
 * and `safeFetch` are module-level `jest.fn()`s whose call history outlived a
 * per-test reset here, and an assertion that read "the first container call"
 * silently read the previous test's. Scoping everything to one helper keeps
 * each expectation about this publish and no other.
 */
async function publishOnce(source: Buffer | null, url: string) {
  metaFetch.mockReset();
  safeFetch.mockReset();
  metaFetch
    .mockResolvedValueOnce(ok({ id: 'CONTAINER1' })) // create
    .mockResolvedValueOnce(ok({ status_code: 'FINISHED' })) // poll
    .mockResolvedValueOnce(ok({ id: 'POST1' })); // publish
  safeFetch.mockResolvedValue(
    source
      ? ({ ok: true, status: 200, arrayBuffer: async () => source, body: null } as never)
      : ({ ok: false, status: 502 } as never),
  );

  const isConfigured = jest
    .spyOn(R2StorageService.prototype, 'isConfigured')
    .mockReturnValue(true);
  const upload = jest
    .spyOn(R2StorageService.prototype, 'upload')
    .mockResolvedValue({ url: 'https://cdn.example/resized.jpg' } as never);

  try {
    await publishToNetwork(igAccount(), 'caption', [url], { mediaMime: ['image/jpeg'] });
    const body = metaFetch.mock.calls.map((c) => c[1]?.body).find((b) => b && 'image_url' in b);
    return { imageUrl: body?.image_url as string | undefined, uploads: upload.mock.calls };
  } finally {
    isConfigured.mockRestore();
    upload.mockRestore();
  }
}

beforeAll(() => {
  process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
});
afterAll(() => {
  delete process.env.MARKETING_SECRET_KEY;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
});

/**
 * The resize used to sit behind `if (!igImageNeedsJpeg(item)) return item`, so
 * it only ran on images being transcoded from PNG/WebP. An already-JPEG image
 * went to Meta at whatever size it was — and Meta fetches `image_url` itself,
 * so an oversized file is a bigger window for a short read. One such fetch came
 * back with its bottom third decoded as flat grey, published and unfixable
 * (Instagram has no "replace the image" edit).
 */
describe('Instagram image preparation', () => {
  it('resizes an oversized JPEG and hands Meta the re-hosted copy', async () => {
    const big = await jpegOf(1440, 1440);
    const { imageUrl, uploads } = await publishOnce(big, 'https://r2.dev/a/big.jpg');

    expect(imageUrl).toBe('https://cdn.example/resized.jpg');
    expect(uploads).toHaveLength(1);
    const out = await Jimp.read(uploads[0][1].buffer);
    expect(out.bitmap.width).toBe(1080);
    expect(uploads[0][1].buffer.length).toBeLessThan(big.length);
  }, 30_000);

  it('leaves a JPEG that is already within Instagram width untouched', async () => {
    const small = await jpegOf(1080, 1350);
    const { imageUrl, uploads } = await publishOnce(small, 'https://r2.dev/a/fine.jpg');

    // No pointless re-encode, and the post keeps its original asset URL.
    expect(imageUrl).toBe('https://r2.dev/a/fine.jpg');
    expect(uploads).toHaveLength(0);
  }, 30_000);

  it('falls back to the original item when the source cannot be fetched', async () => {
    const { imageUrl, uploads } = await publishOnce(null, 'https://r2.dev/a/big.jpg');

    expect(imageUrl).toBe('https://r2.dev/a/big.jpg');
    expect(uploads).toHaveLength(0);
  });
});
