import { detectOptOut } from './optout-keywords';

/**
 * The detector decides whether a human just asked to be left alone. A miss is a
 * KVKK/ETK breach; a false positive silences a paying customer. Both directions
 * are asserted here, and the quoted-footer case is the one that made the naive
 * substring version unusable.
 */
describe('detectOptOut — Turkish', () => {
  it('reads "abonelikten çıkmak istiyorum" as an opt-out', () => {
    expect(detectOptOut('Merhaba, abonelikten çıkmak istiyorum.').matched).toBe(true);
  });

  it('reads the ASCII-typed Turkish spelling too', () => {
    // Half the country types without Turkish characters. Folding both sides is
    // the difference between honouring the request and ignoring it.
    expect(detectOptOut('abonelikten cikmak istiyorum').matched).toBe(true);
    expect(detectOptOut('LUTFEN BENI LISTEDEN CIKARIN').matched).toBe(true);
  });

  it('reads the other phrasings people actually use', () => {
    expect(detectOptOut('Beni listeden çıkarın lütfen').matched).toBe(true);
    expect(detectOptOut('Artık mail göndermeyin.').matched).toBe(true);
    expect(detectOptOut('Bu e-postaları almak istemiyorum').matched).toBe(true);
    expect(detectOptOut('İleti istemiyorum').matched).toBe(true);
  });

  it('names the phrase that fired, for the audit trail', () => {
    expect(detectOptOut('abonelikten çıkmak istiyorum').phrase).toBe('abonelikten cik');
  });
});

describe('detectOptOut — English', () => {
  it('reads the standard phrasings', () => {
    expect(detectOptOut('Please unsubscribe me from this list.').matched).toBe(true);
    expect(detectOptOut('stop emailing me').matched).toBe(true);
    expect(detectOptOut('Remove me from your mailing list').matched).toBe(true);
  });
});

describe('detectOptOut — what must NOT fire', () => {
  it('ignores an unsubscribe footer the reply quoted back at us', () => {
    // Every reply to a campaign carries the footer. Matching it would opt out
    // the whole audience the first time anyone answered.
    const reply = [
      'Teşekkürler, fiyat listesini bekliyorum.',
      '',
      'On Mon, 1 Sep 2026 at 10:00, Jeeta <info@jeeta.com> wrote:',
      '> Kampanyamız başladı!',
      '> Listeden çıkmak için tıklayın: https://x/u/abc',
      '> unsubscribe',
    ].join('\n');
    expect(detectOptOut(reply).matched).toBe(false);
  });

  it('ignores an order cancellation — "iptal" is not an opt-out', () => {
    expect(detectOptOut('Siparişimi iptal edin lütfen, yanlış ürün geldi.').matched).toBe(false);
  });

  it('does not fire on a word that merely CONTAINS a trigger', () => {
    // "dur" lives inside "durum", and a substring matcher opted out everyone
    // who wrote "durumu sorabilir miyim".
    expect(detectOptOut('Siparişimin durumu nedir?').matched).toBe(false);
    expect(detectOptOut('Stopaj oranını sorabilir miyim?').matched).toBe(false);
  });

  it('accepts a bare STOP / DUR only when it is the whole message', () => {
    expect(detectOptOut('DUR').matched).toBe(true);
    expect(detectOptOut('stop').matched).toBe(true);
    expect(detectOptOut('İPTAL').matched).toBe(true);
    expect(detectOptOut('Stop by the office tomorrow').matched).toBe(false);
  });

  it('answers false for nothing at all', () => {
    expect(detectOptOut('').matched).toBe(false);
    expect(detectOptOut(null).matched).toBe(false);
    expect(detectOptOut(undefined).matched).toBe(false);
  });
});

describe('detectOptOut — the subject line', () => {
  it('ignores the subject the email adapter prepends to the body', () => {
    // `EmailChannelAdapter.parseInbound` builds `${subject}\n\n${text}`, so a
    // reply to a campaign titled "Listeden çıkmak için tıklayın" would opt the
    // sender out of a mail they were only answering.
    const withSubject = 'Re: Listeden çıkmak için tıklayın\n\nFiyat listesini gönderir misiniz?';
    expect(detectOptOut(withSubject, { skipFirstLine: true }).matched).toBe(false);
    // …and the body still decides when the request is in the body.
    expect(
      detectOptOut('Re: Kampanya\n\nBeni listeden çıkarın.', { skipFirstLine: true }).matched,
    ).toBe(true);
  });

  it('only drops a first line that is followed by a blank one', () => {
    // A one-line message is the body, not a subject.
    expect(detectOptOut('abonelikten çıkmak istiyorum', { skipFirstLine: true }).matched).toBe(true);
  });
});
