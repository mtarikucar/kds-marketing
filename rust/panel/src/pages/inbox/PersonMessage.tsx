import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { InboxPersonOut } from '@/api/types';
import { Button } from '@/components/ui';
import { personName } from '@/lib/people';
import { ComposeDialog, type ComposeTarget } from '../prospects/MessageDialog';
import { usePoolCopy } from '../prospects/copy';

/**
 * "Mesaj yaz" on a person in the inbox, also one with no conversation yet: the same dialog as a
 * prospect's first message, by email or SMS (a hand-off needs a journey to note on).
 */
export function PersonMessage({ data }: { data: InboxPersonOut }) {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const live = data.identities.filter((i) => i.active);
  const email = live.find((i) => i.channel === 'email')?.value_display ?? null;
  const phone = live.find((i) => i.channel === 'phone')?.value_display ?? null;
  if (!email && !phone) return null;
  const target: ComposeTarget = {
    title: copy('msgTitle', { name: personName(t, data.person, data.identities) }),
    description: data.person.company ?? ' ',
    email,
    phone,
    handle: null,
    handoffs: false,
    business: false,
    draftId: data.person.id,
    afterSend: null,
    noWay: copy('noWayPerson'),
    refresh: () => client.invalidateQueries({ queryKey: ['inbox'] }),
    contact: async () => ({ person_id: data.person.id, journey_id: data.open_journey?.id ?? '' }),
  };
  return (
    <>
      <Button size="sm" variant="outline" className="self-start" onClick={() => setOpen(true)}>
        {copy('writeEmail')}
      </Button>
      {open && <ComposeDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
