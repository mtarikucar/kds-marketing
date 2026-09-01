import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  createOffer,
  sendOffer,
  deleteOffer,
  createTask,
  completeTask,
  deleteTask,
} from '../api/leads.service';

/**
 * The WRITES behind a person's offers and tasks — the six mutations the lead
 * detail page has owned since it was the only surface that had them.
 *
 * They live here because the record card on the person surface now renders the
 * SAME `OffersTab` / `TasksTab` components, and a second copy of "create an
 * offer for this lead" is exactly the "which one is right?" cost this line of
 * work exists to remove. Two copies would drift on the part nobody looks at:
 * the invalidation set. One page refreshing the leads LIST after a task and
 * the other not is invisible in review and obvious to a rep whose row went
 * stale.
 *
 * ## The invalidation set is the whole point
 *
 * `['marketing','lead',id]` is the singular detail read — it carries `offers`
 * and `tasks`, so it is what BOTH surfaces render from. It does NOT prefix-
 * match `['marketing','leads',{filters}]`, so the list and the dashboard are
 * named separately; without them a task created here left the row's counts
 * stale until the next poll.
 *
 * ## A NEW CONSUMER MUST ADD ITS KEY HERE
 *
 * This set is "everything on screen that a write to one person can make wrong",
 * and it is only complete for the surfaces that exist today. A view that
 * renders a person's objects off a key none of these three PREFIX-MATCHES — a
 * task-list key of its own is the obvious next one — goes stale the moment
 * somebody completes a task from the record card, silently, which is precisely
 * the drift this hook was extracted to prevent. Name the key here rather than
 * invalidating it from the new view: two invalidation sets is the state this
 * file exists to end.
 *
 * Exported for the same reason: the lead detail page kept its own copy of these
 * three keys for status / reopen / activity / convert, and a fourth key added
 * to one copy and not the other is invisible in review.
 */
export function useLeadRecordInvalidate(leadId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', leadId] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
  };
}

/** Create / send / delete for one person's offers. */
export function useLeadOfferActions(leadId: string) {
  const invalidate = useLeadRecordInvalidate(leadId);

  const create = useMutation({
    mutationFn: (data: Record<string, unknown>) => createOffer(data),
    onSuccess: () => {
      invalidate();
      toast.success('Offer created');
    },
    onError: () => toast.error('Failed to create offer'),
  });

  const send = useMutation({
    mutationFn: (offerId: string) => sendOffer(offerId),
    onSuccess: () => {
      invalidate();
      toast.success('Offer sent');
    },
    onError: () => toast.error('Failed to send offer'),
  });

  const remove = useMutation({
    mutationFn: (offerId: string) => deleteOffer(offerId),
    onSuccess: () => {
      invalidate();
      toast.success('Offer deleted');
    },
    onError: () => toast.error('Failed to delete offer'),
  });

  return { create, send, remove };
}

/** Create / complete / delete for one person's tasks. */
export function useLeadTaskActions(leadId: string) {
  const invalidate = useLeadRecordInvalidate(leadId);

  const create = useMutation({
    mutationFn: (data: Record<string, unknown>) => createTask(data),
    onSuccess: () => {
      invalidate();
      toast.success('Task created');
    },
    onError: () => toast.error('Failed to create task'),
  });

  const complete = useMutation({
    mutationFn: (taskId: string) => completeTask(taskId),
    onSuccess: () => {
      invalidate();
      toast.success('Task completed');
    },
    onError: () => toast.error('Failed to complete task'),
  });

  const remove = useMutation({
    mutationFn: (taskId: string) => deleteTask(taskId),
    onSuccess: () => {
      invalidate();
      toast.success('Task deleted');
    },
    onError: () => toast.error('Failed to delete task'),
  });

  return { create, complete, remove };
}
