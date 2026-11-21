import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import { legacyTarget, placeSearch, readPlace, selectedRowId, withRow } from './location';
import { foundWords, formatWords, statusLine, subLine, waitSentence, whenWords } from './words';
import { postRow, wait } from '@/test/postsPage';
import { unconnectedPlatforms } from './Composer';

const t = i18n.t.bind(i18n);

describe('the page’s words', () => {
  it('says the publish time as today, tomorrow, or the weekday first', () => {
    const now = new Date(2026, 10, 20, 10, 0);
    expect(whenWords(t, new Date(2026, 10, 20, 9, 30).toISOString(), 'tr', now)).toBe('Bugün 09:30');
    expect(whenWords(t, new Date(2026, 10, 21, 15, 0).toISOString(), 'tr', now)).toBe('Yarın 15:00');
    expect(whenWords(t, new Date(2026, 10, 28, 19, 0).toISOString(), 'tr', now)).toBe('Cmt 28 Kas 19:00');
    expect(whenWords(t, new Date(2027, 0, 9, 19, 0).toISOString(), 'tr', now)).toBe('Cmt 9 Oca 2027 19:00');
    expect(whenWords(t, null, 'tr', now)).toBe('—');
  });

  it('says the format with what its files say', () => {
    expect(formatWords(t, { format: 'tiktok_video', media: { images: 0, video_seconds: 8 } })).toBe('Video · 8 sn');
    expect(formatWords(t, { format: 'carousel', media: { images: 2, video_seconds: null } })).toBe('Kaydırmalı · 2 görsel');
    expect(formatWords(t, { format: 'feed_post', media: { images: 1, video_seconds: null } })).toBe('Gönderi · tek görsel');
    expect(formatWords(t, { format: 'story', media: null })).toBe('Hikâye');
    expect(subLine(t, postRow('slot:a', { format: 'tiktok_video', media: { images: 0, video_seconds: 8 } }))).toBe('Genel · Video 8 sn');
  });

  it('names what was found, and leads the panel with the first wait', () => {
    expect(foundWords(t, ['face', 'company', 'unknown'])).toBe('yüz, kurum adı');
    expect(statusLine(t, postRow('slot:a', { status: 'waiting_you', waits: [wait('posting_screen')] }), 'tr')).toBe('TikTok onayını bekliyor');
    expect(statusLine(t, postRow('content:a', { status: 'preparing', sub_state: { kind: 'claimed', stage: 'gorsel' } }), 'tr')).toBe('Ajan üzerinde çalışıyor · Görsel');
    expect(statusLine(t, postRow('slot:a', { status: 'scheduled' }), 'tr')).toBe('Planlandı');
  });

  it('asks for the TikTok approval and says when the post then goes out by itself', () => {
    const now = new Date(2026, 10, 20, 10, 0);
    const screen = wait('posting_screen');
    expect(waitSentence(t, screen, null, new Date(2026, 10, 24, 19, 0).toISOString(), 'tr', now))
      .toBe('Bu paylaşımı TikTok ekranında onaylaman gerekiyor. Onaylarsan kendiliğinden paylaşılır: Sal 24 Kas 19:00.');
    // Its time passed (inside its grace): approving sends it right away.
    expect(waitSentence(t, screen, null, new Date(2026, 10, 20, 9, 0).toISOString(), 'tr', now))
      .toBe('Bu paylaşımı TikTok ekranında onaylaman gerekiyor. Saati geçti; onaylarsan hemen paylaşılır.');
    expect(t('postsPage.actions.tiktok')).toBe('TikTok ekranında onayla');
  });

  it('finds a platform named in the text that no account takes', () => {
    const connected = [{ kind: 'instagram' }, { kind: 'x' }];
    expect(unconnectedPlatforms("Sadece TikTok'ta, bir de LİNKEDİN", connected)).toEqual(['TikTok', 'LinkedIn']);
    expect(unconnectedPlatforms('instada ve X’te paylaş', connected)).toEqual([]);
    expect(unconnectedPlatforms('Box ve twitterdan', [])).toEqual([]);
    expect(unconnectedPlatforms('twitter ve youtube', [])).toEqual(['X', 'YouTube']);
  });
});

describe('the address', () => {
  it('reads and writes the place in one order', () => {
    const place = readPlace(new URLSearchParams('day=k:2026&section=days&settings=1&f=onay&slot=s1'));
    expect(placeSearch(place)).toBe('?f=onay&slot=s1&settings=1&section=days&day=k%3A2026');
    expect(selectedRowId(place)).toBe('slot:s1');
    expect(withRow(place, 'version:v1')).toMatchObject({ version: 'v1', slot: undefined });
    // Drawer parameters are dropped with their drawer.
    expect(placeSearch({ category: 'o1', account: 'c1', section: 'rules' })).toBe('');
  });

  it('maps the old pages', () => {
    expect(legacyTarget('content', '?olay=o1&file=m1')).toBe('/posts?files=1&category=o1&file=m1');
    expect(legacyTarget('content', '', '#eksikler')).toBe('/posts?f=you');
    expect(legacyTarget('social', '?tab=packages', '#version-v%201')).toBe('/posts?version=v+1');
    expect(legacyTarget('studio', '?tab=materials&olay=review')).toBe('/posts?files=1');
  });
});
