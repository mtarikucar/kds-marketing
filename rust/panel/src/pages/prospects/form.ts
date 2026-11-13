import type { EntityKind, Prospect } from '@/api/types';

// What a person types into the pool's own form, and the request bodies it becomes
// (`jt_prospects::CreateInput`, `jt_prospects::UpdateInput`). A person's evidence for a contact
// value is one manual note, which the server accepts from people only.

/** The contact values a prospect holds as plain text. */
export const CONTACT_FIELDS = ['phone', 'email', 'website', 'instagram', 'tiktok', 'address'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** The business facts an update may set or clear. */
const TEXT_FIELDS = ['segment_key', 'sector', 'city', 'district'] as const;

/** The pool's bounds (`jt_prospects`), in characters. */
export const LIMITS = {
  business_name: 200,
  sector: 80,
  city: 80,
  district: 80,
  email: 254,
  address: 300,
  contact_name: 120,
  contact_role: 80,
  label: 40,
  labels: 20,
  notes: 2000,
  source: 200,
} as const;

export interface ProspectDraft {
  business_name: string;
  entity_kind: EntityKind;
  segment_key: string;
  sector: string;
  city: string;
  district: string;
  phone: string;
  email: string;
  website: string;
  instagram: string;
  tiktok: string;
  address: string;
  contact_name: string;
  contact_role: string;
  /** Comma-separated. */
  labels: string;
  notes: string;
  /** Where the person knows the contact values from: the manual source note. */
  source: string;
}
export type DraftField = keyof ProspectDraft;

export type DraftProblem = 'required' | 'tooLong' | 'email' | 'tooManyLabels' | 'labelTooLong' | 'nameFirst';

/** The form as it opens: empty for a new prospect, the stored values for an existing one. */
export function draftOf(p: Prospect | undefined, source: string): ProspectDraft {
  return {
    business_name: p?.business_name ?? '',
    entity_kind: p?.entity_kind ?? 'unknown_business',
    segment_key: p?.segment_key ?? '',
    sector: p?.sector ?? '',
    city: p?.city ?? '',
    district: p?.district ?? '',
    phone: p?.contact.phone?.value ?? '',
    email: p?.contact.email?.value ?? '',
    website: p?.contact.website?.value ?? '',
    instagram: p?.contact.instagram?.value ?? '',
    tiktok: p?.contact.tiktok?.value ?? '',
    address: p?.contact.address?.value ?? '',
    contact_name: p?.contact.contact_person?.value.name ?? '',
    contact_role: p?.contact.contact_person?.value.role ?? '',
    labels: p?.labels.join(', ') ?? '',
    notes: p?.notes ?? '',
    source,
  };
}

const len = (s: string) => [...s].length;

/** The labels of a comma-separated line: trimmed, each once, in the order typed. */
export function labelsOf(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',')) {
    const label = part.trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** A website as the pool stores it: an address typed without a scheme gets `https://`. */
export function websiteOf(text: string): string {
  const v = text.trim();
  return !v || /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** What the form itself can tell is wrong; the server judges the rest (phone, handles, website). */
export function problemsOf(d: ProspectDraft, mode: 'create' | 'edit'): Partial<Record<DraftField, DraftProblem>> {
  const out: Partial<Record<DraftField, DraftProblem>> = {};
  const bound = (field: DraftField, max: number) => {
    if (len(d[field].trim()) > max) out[field] = 'tooLong';
  };
  if (mode === 'create') {
    if (!d.business_name.trim()) out.business_name = 'required';
    else bound('business_name', LIMITS.business_name);
    bound('notes', LIMITS.notes);
  }
  bound('sector', LIMITS.sector);
  bound('city', LIMITS.city);
  bound('district', LIMITS.district);
  bound('address', LIMITS.address);
  bound('contact_name', LIMITS.contact_name);
  bound('contact_role', LIMITS.contact_role);
  const email = d.email.trim();
  if (email && (len(email) > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) out.email = 'email';
  if (d.contact_role.trim() && !d.contact_name.trim()) out.contact_name = 'nameFirst';
  const labels = labelsOf(d.labels);
  if (labels.length > LIMITS.labels) out.labels = 'tooManyLabels';
  else if (labels.some((l) => len(l) > LIMITS.label)) out.labels = 'labelTooLong';
  if (!d.source.trim()) out.source = 'required';
  else bound('source', LIMITS.source);
  return out;
}

const contactValue = (d: ProspectDraft, k: ContactField) => (k === 'website' ? websiteOf(d.website) : d[k].trim());

/** `jt_prospects::CreateInput` for a person's own record: every contact value under the manual note. */
export function createBody(d: ProspectDraft, capturedAt: string, requestKey: string): Record<string, unknown> {
  const source = { kind: 'manual', note: d.source.trim() };
  const evidenced = <T>(value: T) => ({ value, sources: [source], captured_at: capturedAt });
  const body: Record<string, unknown> = {
    business_name: d.business_name.trim(),
    entity_kind: d.entity_kind,
    labels: labelsOf(d.labels),
    notes: d.notes.trim(),
    discovered_at: [source],
    request_key: requestKey,
  };
  for (const f of TEXT_FIELDS) {
    const v = d[f].trim();
    if (v) body[f] = v;
  }
  for (const k of CONTACT_FIELDS) {
    const v = contactValue(d, k);
    if (v) body[k] = evidenced(v);
  }
  const name = d.contact_name.trim();
  if (name) body.contact_person = evidenced({ name, role: d.contact_role.trim() });
  return body;
}

/**
 * `jt_prospects::UpdateInput` holding only what the person changed: a changed value is set (a
 * contact value under the manual note), an emptied one cleared. A contact value left as it was is
 * not sent, so it keeps the evidence it was recorded with. `null` when nothing changed.
 */
export function updateBody(p: Prospect, d: ProspectDraft, capturedAt: string): Record<string, unknown> | null {
  const source = { kind: 'manual', note: d.source.trim() };
  const evidenced = <T>(value: T) => ({ value, sources: [source], captured_at: capturedAt });
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  const change = (field: string, before: string, after: string, value: unknown) => {
    if (after === before) return;
    if (after) set[field] = value;
    else clear.push(field);
  };
  for (const f of TEXT_FIELDS) {
    const after = d[f].trim();
    change(f, p[f] ?? '', after, after);
  }
  const labels = labelsOf(d.labels);
  change('labels', p.labels.length ? JSON.stringify(p.labels) : '', labels.length ? JSON.stringify(labels) : '', labels);
  for (const k of CONTACT_FIELDS) {
    const after = contactValue(d, k);
    change(k, p.contact[k]?.value ?? '', after, evidenced(after));
  }
  const before = p.contact.contact_person?.value;
  const name = d.contact_name.trim();
  const role = d.contact_role.trim();
  if (name !== (before?.name ?? '') || (name !== '' && role !== (before?.role ?? ''))) {
    if (name) set.contact_person = evidenced({ name, role });
    else clear.push('contact_person');
  }
  if (Object.keys(set).length === 0 && clear.length === 0) return null;
  return { expected_revision: p.revision, set, clear };
}
