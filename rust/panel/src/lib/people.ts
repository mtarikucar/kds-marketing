import type { TFunction } from 'i18next';
import type { InboxPerson, InboxPersonOut } from '@/api/types';

type Identity = InboxPersonOut['identities'][number];

/** The contact channels a person can come through (`jt_inbox::Channel`, `IdentityChannel`). */
const CHANNELS = ['whats_app', 'instagram_dm', 'messenger', 'sms', 'email', 'webchat', 'phone'] as const;
type ChannelKey = (typeof CHANNELS)[number];

function isChannel(channel: string): channel is ChannelKey {
  return (CHANNELS as readonly string[]).includes(channel);
}

/** Identities whose value reads as a name would: a phone number or an e-mail address. */
const READABLE = new Set(['phone', 'email']);

/**
 * What to call a person, never a bare id: their name; else a phone number or e-mail address they
 * are known by; else the channel they came through, with the end of their provider id
 * ("Messenger contact · …5601") when the identities are at hand.
 */
export function personName(
  t: TFunction,
  person: Pick<InboxPerson, 'display_name' | 'first_touch' | 'erased_at'> | undefined,
  identities?: Identity[],
): string {
  if (!person) return '…';
  const name = person.display_name.trim();
  if (name) return name;
  if (person.erased_at) return t('people.erased');
  const live = identities?.filter((identity) => identity.active) ?? [];
  const readable = live.find((identity) => READABLE.has(identity.channel));
  if (readable) return readable.value_display;
  const opaque = live[0];
  const source = person.first_touch.source;
  const channel = opaque?.channel ?? (typeof source === 'object' ? source.channel : undefined);
  if (!channel || !isChannel(channel)) return t('people.unnamed');
  const label = t('people.unnamedOn', { channel: t(`people.channels.${channel}`) });
  const tail = opaque?.value_display.slice(-4);
  return tail ? `${label} · …${tail}` : label;
}
