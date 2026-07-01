/**
 * Provider-agnostic conferencing contract. A booking's video meeting is created
 * by whichever provider its calendar opted into (Google Meet via Calendar
 * `conferenceData`, or Microsoft Teams via Graph `onlineMeeting`), hosted by the
 * assigned staff member's own connected account (see HostResolverService).
 */
export type ConferenceProviderKind = 'GOOGLE_MEET' | 'TEAMS';

/** The outcome of provisioning a conference for one booking. */
export interface ConferenceResult {
  provider: ConferenceProviderKind;
  /** Join URL; null while Google reports `conferenceData` still pending. */
  joinUrl: string | null;
  /** hangout id / onlineMeeting id — for teardown + the pending follow-up get. */
  conferenceId: string | null;
  /** Stable per booking (`bk<id>`), so retries never spawn duplicate meetings. */
  requestId: string;
  status: 'created' | 'pending' | 'failed';
}

/** The connected account that will host a booking's conference. */
export interface HostConnection {
  kind: ConferenceProviderKind;
  connectionId: string;
  marketingUserId: string;
}
