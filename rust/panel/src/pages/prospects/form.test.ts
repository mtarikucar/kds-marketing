import { describe, expect, it } from 'vitest';
import { prospect } from '@/test/leads';
import { createBody, draftOf, labelsOf, problemsOf, updateBody, websiteOf } from './form';

const AT = '2026-11-13T12:00:00.000Z';
const manual = { kind: 'manual', note: 'Fuarda kartvizit aldım' };
const evidenced = (value: unknown) => ({ value, sources: [manual], captured_at: AT });

describe('prospect form', () => {
  it('reads_labels_and_websites_as_typed', () => {
    expect(labelsOf(' fuar, okul ,, fuar ,')).toEqual(['fuar', 'okul']);
    expect(websiteOf(' ornek.com.tr ')).toBe('https://ornek.com.tr');
    expect(websiteOf('http://ornek.com.tr')).toBe('http://ornek.com.tr');
    expect(websiteOf('  ')).toBe('');
  });

  it('names_what_the_form_can_tell_is_wrong', () => {
    const empty = draftOf(undefined, '');
    expect(problemsOf(empty, 'create')).toEqual({ business_name: 'required', source: 'required' });
    // An existing prospect's name is not the form's to judge.
    expect(problemsOf(empty, 'edit')).toEqual({ source: 'required' });
    const bad = {
      ...draftOf(undefined, 'Elle girildi'),
      business_name: 'Örnek Atölye',
      email: 'merhaba@ornek',
      contact_role: 'Kurucu',
      labels: Array.from({ length: 21 }, (_, i) => `e${i}`).join(','),
      sector: 'x'.repeat(81),
    };
    expect(problemsOf(bad, 'create')).toEqual({
      email: 'email',
      contact_name: 'nameFirst',
      labels: 'tooManyLabels',
      sector: 'tooLong',
    });
    expect(problemsOf({ ...bad, labels: 'y'.repeat(41) }, 'create').labels).toBe('labelTooLong');
  });

  it('builds_a_create_body_with_manual_evidence', () => {
    const draft = {
      ...draftOf(undefined, ' Fuarda kartvizit aldım '),
      business_name: ' Örnek Atölye ',
      segment_key: 'atolye',
      city: 'İzmir',
      phone: '0532 000 00 00',
      website: 'ornek-atolye.example.invalid',
      contact_name: 'Ayşe Örnek',
      labels: 'fuar, sıcak',
      notes: ' Aralıkta atölye istiyor. ',
    };
    expect(createBody(draft, AT, 'key-1')).toEqual({
      business_name: 'Örnek Atölye',
      entity_kind: 'unknown_business',
      segment_key: 'atolye',
      city: 'İzmir',
      labels: ['fuar', 'sıcak'],
      notes: 'Aralıkta atölye istiyor.',
      phone: evidenced('0532 000 00 00'),
      website: evidenced('https://ornek-atolye.example.invalid'),
      contact_person: evidenced({ name: 'Ayşe Örnek', role: '' }),
      discovered_at: [manual],
      request_key: 'key-1',
    });
  });

  it('sends_only_what_changed_on_an_update', () => {
    const p = prospect(1, { labels: ['fuar'] });
    const source = 'Fuarda kartvizit aldım';
    // Nothing touched: nothing to send, and the agent's evidence stays as recorded.
    expect(updateBody(p, draftOf(p, source), AT)).toBeNull();

    const draft = {
      ...draftOf(p, source),
      segment_key: 'atolye',
      district: '',
      phone: '+905320000000',
      email: '',
      instagram: '@ornekkafe',
      contact_name: 'Ayşe Örnek',
      contact_role: 'Kurucu',
      labels: '',
    };
    expect(updateBody(p, draft, AT)).toEqual({
      expected_revision: 3,
      set: {
        segment_key: 'atolye',
        phone: evidenced('+905320000000'),
        instagram: evidenced('@ornekkafe'),
        contact_person: evidenced({ name: 'Ayşe Örnek', role: 'Kurucu' }),
      },
      clear: ['district', 'labels', 'email'],
    });
  });
});
