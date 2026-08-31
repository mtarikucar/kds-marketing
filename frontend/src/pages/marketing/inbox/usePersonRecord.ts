import { useQuery } from '@tanstack/react-query';
import { getLead } from '../../../features/marketing/api/leads.service';

/**
 * The person's own record — the read behind BOTH the GÖREVLER and the
 * TEKLİFLER sections of the record card.
 *
 * ## Why this one is eager while two of its neighbours are not
 *
 * The card has five sections now, and firing five requests every time a rep
 * clicks a row in the left column would be five requests for data most people
 * do not have. So the split is a rule rather than a taste:
 *
 *   **a section whose data is already a FIELD of the person's record loads
 *   with the person; a section that needs its own endpoint waits until someone
 *   opens it.**
 *
 * `GET /leads/:id` returns `offers` and `tasks` inline (the backend's own
 * `findOne` include). One request therefore serves two sections AND their
 * contents — being lazy about it would save nothing and would hide two of the
 * four things a rep triaging a person most often wants. Estimates and
 * appointments each need a separate call for objects most contacts do not
 * have, so those two are disclosures (`PersonEstimates`, `PersonAppointments`).
 *
 * ## Why the key is shared with the lead detail page
 *
 * `['marketing','lead', id]` is LeadDetailPage's key, deliberately. The card
 * and the detail page then read ONE cache entry, so they cannot disagree about
 * what this person's tasks are; a task created on either surface refreshes the
 * other; and clicking through to `/leads/:id` opens warm. It is also what the
 * surface's SSE handler already invalidates for the selected person, so an
 * inbound message that an automation turns into a task shows up without a
 * reload.
 *
 * The cost is honest and worth naming: the two sections share a query, so they
 * share a FATE. When it fails they both fail — but each one says its own name
 * and neither is mistaken for empty, which is the rule that actually matters.
 * Splitting them into two requests for one payload would buy nothing but a
 * second request.
 */
export function usePersonRecord(leadId: string) {
  return useQuery({
    queryKey: ['marketing', 'lead', leadId],
    queryFn: () => getLead(leadId),
  });
}
