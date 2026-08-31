import { callActivityMetadata, salesCallIdOf } from './call-activity';
import { assignmentOf } from '../services/lead-stream.service';

/**
 * The one shape that connects a person's stream row back to the call it came
 * from. Written by two places (SalesCallService.logCall, the inbound mirror in
 * TelephonyEventConsumer) and read by one (LeadStreamService), which is exactly
 * why the writer and the reader live in one file: a stream row that cannot name
 * its call is a dead end, and that is the gap this module closes.
 */
describe('call-activity — the SalesCall id on the mirrored LeadActivity', () => {
  it('stamps the call id under its own kind', () => {
    expect(callActivityMetadata('call-1')).toEqual({ kind: 'call', salesCallId: 'call-1' });
  });

  it('reads the id back out', () => {
    expect(salesCallIdOf(callActivityMetadata('call-1'))).toBe('call-1');
  });

  /**
   * The backfill that cannot happen. Every CALL activity written before this
   * module existed has `metadata: null`, and there is no column anywhere
   * pairing those rows to their call. They must answer "no id" rather than
   * something a player could be pointed at.
   */
  it('answers null for a legacy row that carries no metadata at all', () => {
    for (const legacy of [null, undefined, {}, 'not-an-object', 42, []]) {
      expect(salesCallIdOf(legacy)).toBeNull();
    }
  });

  it('refuses metadata belonging to another kind', () => {
    // An assignment row is a STATUS_CHANGE, but nothing stops a future writer
    // from putting an id on one; the discriminator is what keeps them apart.
    expect(salesCallIdOf({ kind: 'assignment', salesCallId: 'call-1' })).toBeNull();
    expect(salesCallIdOf({ kind: 'opportunity', opportunityId: 'opp-1' })).toBeNull();
  });

  it('refuses an id that is not a non-empty string', () => {
    for (const bad of [{ kind: 'call' }, { kind: 'call', salesCallId: '' }, { kind: 'call', salesCallId: 7 }]) {
      expect(salesCallIdOf(bad)).toBeNull();
    }
  });

  /**
   * The other direction of the same separation: `assignmentOf` is the only
   * reader that reacts to `kind`, and a call row must not wear an assignment
   * badge — the mistake opportunity-activity.ts documents having avoided.
   */
  it('never reads as an assignment', () => {
    expect(assignmentOf(callActivityMetadata('call-1'))).toBeNull();
  });
});
