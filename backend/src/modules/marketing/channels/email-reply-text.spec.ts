import { stripQuotedReply } from './email-reply-text';

/**
 * The IMAP poller is the only inbound path that receives a raw reply, so these
 * rules are the difference between the conversation view showing a sentence
 * and showing the whole thread again.
 */
describe('stripQuotedReply', () => {
  it('keeps a reply that quotes nothing', () => {
    expect(stripQuotedReply('Merhaba, fiyat listesi gönderebilir misiniz?')).toBe(
      'Merhaba, fiyat listesi gönderebilir misiniz?',
    );
  });

  it('cuts at the Gmail English attribution', () => {
    const raw = [
      'Evet, ilgileniyorum.',
      '',
      'On Mon, 8 Sep 2026 at 14:02, Hummy Tummy <admin@hummytummy.com> wrote:',
      '> Merhaba Tarık,',
      '> Bu mesaj panelden gönderildi.',
    ].join('\n');
    expect(stripQuotedReply(raw)).toBe('Evet, ilgileniyorum.');
  });

  it('cuts at the Turkish attribution', () => {
    // The line Turkish Gmail writes. Missing this one is why the guard exists
    // at all: the customers this product mails are Turkish.
    const raw = [
      'Yarın arayabilir misiniz?',
      '',
      '8 Eyl 2026 Sal, saat 14:02 tarihinde Hummy Tummy <admin@hummytummy.com> şunu yazdı:',
      '> Merhaba,',
    ].join('\n');
    expect(stripQuotedReply(raw)).toBe('Yarın arayabilir misiniz?');
  });

  it('cuts at the Outlook original-message separator', () => {
    const raw = 'Tamamdır.\n\n-----Original Message-----\nFrom: Hummy Tummy\n';
    expect(stripQuotedReply(raw)).toBe('Tamamdır.');
  });

  it('cuts at the Outlook underscore rule', () => {
    const raw = 'Olur.\n\n________________________________\nKimden: Hummy Tummy\n';
    expect(stripQuotedReply(raw)).toBe('Olur.');
  });

  it('cuts at a bare quoted line when the client left no attribution', () => {
    expect(stripQuotedReply('Yok teşekkürler.\n> Merhaba Tarık,')).toBe('Yok teşekkürler.');
  });

  it('drops the signature after the RFC 3676 delimiter', () => {
    expect(stripQuotedReply('Peki.\n\n-- \nTarık\nHummy Tummy')).toBe('Peki.');
  });

  it('returns the message WHOLE rather than empty when it is only a quote', () => {
    // A "+1"-style reply that top-posts nothing, or a marker on line one.
    // Delivering an empty message would look like the customer said nothing;
    // delivering the quote at least shows what arrived.
    const raw = '> Merhaba Tarık,\n> Bu mesaj panelden gönderildi.';
    expect(stripQuotedReply(raw)).toBe(raw);
  });

  it('does not cut on prose that merely mentions the marker words', () => {
    // "tarihinde" is an ordinary Turkish word; only the full attribution shape
    // (…tarihinde … yazdı:) is a separator. A false cut silently truncates a
    // customer's message, which is worse than leaving a quote in.
    const raw = 'Sözleşmenin bittiği tarihinde bize haber verin lütfen.';
    expect(stripQuotedReply(raw)).toBe(raw);
  });

  it('handles CRLF, which is what actually comes off the wire', () => {
    expect(stripQuotedReply('Olur.\r\n\r\n> onceki\r\n')).toBe('Olur.');
  });

  it('passes empty input through untouched', () => {
    expect(stripQuotedReply('')).toBe('');
    expect(stripQuotedReply('   ')).toBe('   ');
  });
});
