import { useQuery } from '@tanstack/react-query';
import { getLead } from '../api/leads.service';

/**
 * `GET /leads/:id` — the person's own record, with its offers and tasks
 * inline. THE read behind the lead detail page and behind the record card's
 * GÖREVLER and TEKLİFLER sections.
 *
 * One hook rather than two `useQuery` calls on the same key, because two would
 * be free to disagree about the OPTIONS — and they did, in the first draft of
 * this: the detail page refuses to retry a 404 (a deleted lead is the answer,
 * not a blip) and the card would have burned three retries on it. React Query
 * keys the cache, not the policy, so a shared key with unshared options is a
 * behaviour that depends on which surface mounted first.
 *
 * The policy is asserted by CALL COUNT in `useLeadRecord.test.tsx` — one
 * request for a 404, three for anything else. It had no direct test until then,
 * and dropping the 404 clause passed the whole suite.
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
 * Two costs, both deliberate and both worth naming.
 *
 * The two sections share a query, so they share a FATE: when it fails they
 * both fail. Each still says its OWN name and neither is mistaken for empty,
 * which is the rule that actually matters, and splitting one payload into two
 * requests would have bought nothing else.
 *
 * And on the person surface this key now has an ACTIVE observer, where before
 * only its `…,'stream'` child did — so the SSE handler's per-frame
 * `invalidateQueries(['marketing','lead',id])` refetches this too, one extra
 * request per workspace event while a person is selected. That is the right
 * trade rather than an oversight: an inbound message is exactly what an
 * automation turns into a task, and a task list that needs a reload to appear
 * is worse than a request. If it ever stops being the right trade, the fix is
 * the one the surface already names — a `leadId` on ConversationStreamEvent,
 * so a frame refreshes the person it is actually about.
 */
export function useLeadRecord(leadId: string) {
  return useQuery({
    queryKey: ['marketing', 'lead', leadId],
    queryFn: () => getLead(leadId),
    // A genuine 404 (deleted lead) is the answer, not a transient failure —
    // don't burn retries on it; let the caller's not-found branch render.
    retry: (failureCount, err: any) => (err?.response?.status === 404 ? false : failureCount < 2),
  });
}
