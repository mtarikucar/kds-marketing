// tiktok-creator-info.util.spec.ts
import { safeFetch } from '../../../common/util/safe-fetch';
import { queryCreatorInfo, validatePrivacyLevel } from './tiktok-creator-info.util';

jest.mock('../../../common/util/safe-fetch');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;
const resp = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response);

describe('tiktok-creator-info.util', () => {
  afterEach(() => jest.resetAllMocks());

  it('parses the creator-info option set', async () => {
    mockedFetch.mockResolvedValue(
      resp({
        data: {
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 300,
        },
      }),
    );
    const info = await queryCreatorInfo('tok');
    expect(info.privacyLevelOptions).toContain('PUBLIC_TO_EVERYONE');
    expect(info.duetDisabled).toBe(true);
    expect(info.maxVideoPostDurationSec).toBe(300);
  });

  it('clips a privacy level the account cannot use down to the first allowed option', () => {
    const info = { privacyLevelOptions: ['SELF_ONLY'], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 60 };
    expect(validatePrivacyLevel('PUBLIC_TO_EVERYONE', info)).toBe('SELF_ONLY');
    expect(validatePrivacyLevel('SELF_ONLY', info)).toBe('SELF_ONLY');
  });
});
