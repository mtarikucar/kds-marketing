import { AI_DECLINE_CODES, splitDeclineReason } from './ai-decline-reason';

/**
 * "Yapay zekâ bu konuşmada yanıt vermedi: conversation is CLOSED, not OPEN".
 *
 * That sentence shipped to a Turkish rep with its second half in English,
 * because `Conversation.aiLastDeclineReason` is a free-text column written by
 * the engine and rendered verbatim by the inbox (PLAN G8: a server reason is
 * never printed raw).
 *
 * The column cannot become an enum — no migration, and it already holds prose
 * for every thread the engine has ever declined. So a code is PREFIXED onto the
 * prose it explains: the reader maps the code when it knows it and shows the
 * prose when it does not, which is exactly today's behaviour for a row written
 * before this existed.
 */
describe('splitDeclineReason', () => {
  it('splits a coded reason into its code and its prose', () => {
    expect(splitDeclineReason('AI_PAUSED: AI paused on this conversation')).toEqual({
      code: 'AI_PAUSED',
      text: 'AI paused on this conversation',
    });
  });

  it('leaves a row written before codes existed exactly as it is', () => {
    expect(splitDeclineReason('channel not found')).toEqual({
      code: null,
      text: 'channel not found',
    });
  });

  it('does not invent a code out of prose that happens to contain a colon', () => {
    // Only an ALL-CAPS token at the very head is a code. "Note: ..." is prose.
    expect(splitDeclineReason('Note: the channel refused it')).toEqual({
      code: null,
      text: 'Note: the channel refused it',
    });
    expect(splitDeclineReason('daily reply cap reached (5/day): lost the race')).toEqual({
      code: null,
      text: 'daily reply cap reached (5/day): lost the race',
    });
  });

  it('refuses a code it does not know, rather than handing the UI a dead key', () => {
    expect(splitDeclineReason('WAT_IS_THIS: something')).toEqual({
      code: null,
      text: 'WAT_IS_THIS: something',
    });
  });

  it('is null-safe and trims, so an empty column renders nothing', () => {
    expect(splitDeclineReason(null)).toEqual({ code: null, text: '' });
    expect(splitDeclineReason('   ')).toEqual({ code: null, text: '' });
    expect(splitDeclineReason('AI_PAUSED:   spaced  ')).toEqual({
      code: 'AI_PAUSED',
      text: 'spaced',
    });
  });

  it('keeps a bare code usable on its own', () => {
    expect(splitDeclineReason('AI_PAUSED')).toEqual({ code: 'AI_PAUSED', text: '' });
  });

  it('lists every code the inbox has to be able to name', () => {
    // The frontend ships one `inbox.aiDeclineReason.<CODE>` string per entry, in
    // both catalogues. A code added here without its copy prints the prose —
    // degraded, not broken — but this list is what the two sides agree on.
    expect([...AI_DECLINE_CODES].sort()).toEqual(
      [
        'AGENT_INACTIVE',
        'AGENT_MISSING',
        'AI_PAUSED',
        'CHANNEL_INACTIVE',
        'CHANNEL_MISSING',
        'CONVERSATION_MISSING',
        'CONVERSATION_NOT_OPEN',
        'DAILY_CAP',
        'LEAD_GONE',
        'MESSAGE_QUOTA',
        'REPLY_DISABLED',
        'SEND_REFUSED',
        'SEND_REFUSED_RETRY',
      ].sort(),
    );
  });
});
