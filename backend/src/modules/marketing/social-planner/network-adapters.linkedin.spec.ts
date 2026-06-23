import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { publishToNetwork, AccountRow } from './network-adapters';

jest.mock('../../../common/util/safe-fetch');
const mockFetch = fetchMod.safeFetch as jest.Mock;
const okRes = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;

describe('publishLinkedIn — author URN by accountType', () => {
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
  });
  beforeEach(() => {
    process.env.LINKEDIN_CLIENT_ID = 'a';
    process.env.LINKEDIN_CLIENT_SECRET = 'b';
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okRes({ id: 'urn:li:share:1' }));
  });

  const account = (accountType: string | null): AccountRow => ({
    id: 'acc',
    network: 'LINKEDIN',
    externalId: 'ABC123',
    accessToken: sealSecret('tok'),
    accountType,
  });

  it('uses an organization URN for LI_ORG', async () => {
    await publishToNetwork(account('LI_ORG'), 'hello', []);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.author).toBe('urn:li:organization:ABC123');
  });

  it('uses a person URN for LI_PERSON (and legacy null)', async () => {
    await publishToNetwork(account('LI_PERSON'), 'hello', []);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).author).toBe('urn:li:person:ABC123');

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(okRes({ id: 'urn:li:share:2' }));
    await publishToNetwork(account(null), 'hello', []);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).author).toBe('urn:li:person:ABC123');
  });
});
