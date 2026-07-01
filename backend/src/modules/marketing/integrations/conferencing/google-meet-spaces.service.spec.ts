import * as safeFetchModule from '../../../../common/util/safe-fetch';
import {
  GoogleMeetSpacesService,
  parseMeetSpaceConfig,
} from './google-meet-spaces.service';

function makeSvc(over: { configured?: boolean; advanced?: boolean } = {}) {
  const google = {
    isConfigured: () => over.configured ?? true,
    hasAdvancedMeet: () => over.advanced ?? true,
    getFreshAccessToken: jest.fn().mockResolvedValue('tok'),
  };
  return { s: new GoogleMeetSpacesService(google as any), google };
}

const CONN = {
  id: 'c',
  workspaceId: 'ws',
  googleCalendarId: 'primary',
  scopes: 'https://www.googleapis.com/auth/meetings.space.created',
} as any;

describe('GoogleMeetSpacesService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('available() requires configured + the advanced scope', () => {
    expect(makeSvc({ configured: true, advanced: true }).s.available(CONN)).toBe(true);
    expect(makeSvc({ configured: false }).s.available(CONN)).toBe(false);
    expect(makeSvc({ advanced: false }).s.available(CONN)).toBe(false);
  });

  it('createConfiguredSpace returns null when advanced Meet is unavailable', async () => {
    const { s } = makeSvc({ advanced: false });
    expect(await s.createConfiguredSpace(CONN, { recording: true })).toBeNull();
  });

  it('creates a space with recording/transcript config and returns its uri', async () => {
    const { s } = makeSvc();
    jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({
      ok: true,
      json: async () => ({ meetingUri: 'https://meet.google.com/xyz', meetingCode: 'xyz' }),
    } as any);
    const res = await s.createConfiguredSpace(CONN, { recording: true, transcript: true });
    expect(res).toEqual({ meetingUri: 'https://meet.google.com/xyz', meetingCode: 'xyz' });
    const call = (safeFetchModule.safeFetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.config.artifactConfig.recordingConfig.autoRecordingGeneration).toBe('ON');
    expect(body.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration).toBe('ON');
  });

  it('returns null on a non-ok Meet API response', async () => {
    const { s } = makeSvc();
    jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({
      ok: false, status: 403, text: async () => '',
    } as any);
    expect(await s.createConfiguredSpace(CONN, { recording: true })).toBeNull();
  });

  it('parseMeetSpaceConfig returns null unless an advanced feature is requested', () => {
    expect(parseMeetSpaceConfig({})).toBeNull();
    expect(parseMeetSpaceConfig(null)).toBeNull();
    expect(parseMeetSpaceConfig({ recording: true })).toMatchObject({ recording: true });
    expect(parseMeetSpaceConfig({ accessType: 'RESTRICTED' })).toMatchObject({ accessType: 'RESTRICTED' });
  });
});
