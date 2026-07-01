import { Injectable, Logger } from '@nestjs/common';
import { safeFetch, SsrfBlockedError } from '../../../../common/util/safe-fetch';
import {
  GoogleCalendarService,
  GoogleCalendarConnectionRow,
} from '../google-calendar.service';

const MEET_SPACES_ENDPOINT = 'https://meet.googleapis.com/v2/spaces';

/** Advanced-space options derived from a calendar's `conferenceConfig` JSON. */
export interface MeetSpaceConfig {
  recording?: boolean;
  transcript?: boolean;
  moderation?: boolean; // host controls / co-host
  accessType?: 'OPEN' | 'TRUSTED' | 'RESTRICTED';
}

export interface MeetSpace {
  meetingUri: string;
  meetingCode: string;
}

/**
 * Advanced Google Meet spaces (Phase 4) — provisions a Meet with recording /
 * transcript / moderation config via the Meet REST v2 API. INERT unless the
 * host connection was granted the `meetings.space.created` scope AND the Google
 * app is verified for it. Best-effort: returns null on any gap so the standard
 * conferenceData Meet (Phase 1) remains the fallback and the booking never fails.
 */
@Injectable()
export class GoogleMeetSpacesService {
  private readonly logger = new Logger(GoogleMeetSpacesService.name);

  constructor(private readonly google: GoogleCalendarService) {}

  /** Whether a configured advanced space can be created for this connection. */
  available(conn: { scopes: string | null }): boolean {
    return this.google.isConfigured() && this.google.hasAdvancedMeet(conn);
  }

  /**
   * Create a Meet space with the requested config; returns its join URI +
   * meeting code (to attach to the calendar event), or null when advanced Meet
   * is unavailable or the API call fails.
   */
  async createConfiguredSpace(
    conn: GoogleCalendarConnectionRow,
    config: MeetSpaceConfig,
  ): Promise<MeetSpace | null> {
    if (!this.available(conn)) return null;
    const body: Record<string, unknown> = {
      config: {
        accessType: config.accessType ?? 'TRUSTED',
        entryPointAccess: 'ALL',
        ...(config.moderation ? { moderation: 'ON' } : {}),
        ...(config.recording || config.transcript
          ? {
              artifactConfig: {
                ...(config.recording
                  ? { recordingConfig: { autoRecordingGeneration: 'ON' } }
                  : {}),
                ...(config.transcript
                  ? { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } }
                  : {}),
              },
            }
          : {}),
      },
    };
    try {
      const accessToken = await this.google.getFreshAccessToken(conn);
      const res = await safeFetch(MEET_SPACES_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: 8000,
      });
      if (!res.ok) {
        await res.text().catch(() => undefined);
        this.logger.warn(`Meet space create failed: HTTP ${res.status}`);
        return null;
      }
      const space = (await res.json()) as { meetingUri?: string; meetingCode?: string };
      if (!space.meetingUri) return null;
      return { meetingUri: space.meetingUri, meetingCode: space.meetingCode ?? '' };
    } catch (e) {
      if (e instanceof SsrfBlockedError) this.logger.warn(`Meet space blocked: ${e.message}`);
      else this.logger.warn(`Meet space error: ${(e as Error).message}`);
      return null;
    }
  }
}

/** Derive a MeetSpaceConfig from a calendar's conferenceConfig JSON, or null
 *  when no advanced feature is requested. */
export function parseMeetSpaceConfig(raw: unknown): MeetSpaceConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const accessType = ['OPEN', 'TRUSTED', 'RESTRICTED'].includes(c.accessType as string)
    ? (c.accessType as 'OPEN' | 'TRUSTED' | 'RESTRICTED')
    : undefined;
  const cfg: MeetSpaceConfig = {
    recording: !!c.recording,
    transcript: !!c.transcript,
    moderation: !!c.moderation,
    accessType,
  };
  return cfg.recording || cfg.transcript || cfg.moderation || cfg.accessType ? cfg : null;
}
