import { Disclosure, type DisclosureProps } from '@/components/ui/Disclosure';

export type RecordDisclosureProps = DisclosureProps;

/**
 * A record-card section that costs nothing until it is opened.
 *
 * The card has five sections. Two of them — estimates and appointments — each
 * need their own endpoint, for objects most contacts do not have, and firing
 * both on every row a rep clicks through would be two wasted requests per
 * person for a screen nobody looked at. So they are disclosures: the body is
 * an unrendered element until `open`, which means the child component function
 * never runs and its `useQuery` never registers. Nothing subtler than that is
 * needed — and nothing subtler would be honest, because a query that exists
 * but is `enabled: false` is still a query somebody can flip on by accident.
 *
 * The two sections that ride on `GET /leads/:id` are NOT disclosures, because
 * their data arrives with the person either way — see `useLeadRecord`.
 *
 * `open` is per-person state. The card is handed a new person rather than
 * remounted (selecting is not navigating), so the caller keys this by lead id;
 * without that, "I opened Randevular for Ayşe" becomes "Randevular is open for
 * whoever is selected next", and the section fetches for someone nobody asked
 * about.
 *
 * The implementation now lives in `components/ui/Disclosure`, because the
 * Studio's recurring tools stack sections of exactly this shape and a second
 * copy would have drifted from this one. This name stays because it is what the
 * record card's own vocabulary calls it, and because the essay above is about
 * THIS card's five sections rather than about a generic control.
 */
export function RecordDisclosure(props: RecordDisclosureProps) {
  return <Disclosure {...props} />;
}
