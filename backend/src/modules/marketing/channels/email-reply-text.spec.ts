import { stripQuotedReply, truncateHtmlQuote } from './email-reply-text';

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

  describe('only a TRAILING quote block is quoted', () => {
    it('keeps interleaved answers, which are the whole point of quoting inline', () => {
      // The old rule cut at the FIRST '>' anywhere, so this customer's two
      // answers were both thrown away and the AI answered a blank message.
      const raw = [
        '> Fiyat nedir?',
        '1.200 TL.',
        '',
        '> Teslimat ne zaman?',
        'Cuma günü kargoda.',
      ].join('\n');
      expect(stripQuotedReply(raw)).toBe(raw);
    });

    it('still cuts the trailing block when an inline answer came first', () => {
      const raw = ['> Fiyat nedir?', '1.200 TL.', '', '> Merhaba,', '> Bu mesaj panelden gönderildi.'].join('\n');
      expect(stripQuotedReply(raw)).toBe('> Fiyat nedir?\n1.200 TL.');
    });

    it('walks up through the blank lines a client leaves inside the quote', () => {
      expect(stripQuotedReply('Olur.\n\n> satır bir\n\n> satır iki\n')).toBe('Olur.');
    });
  });

  describe('wrapped attributions', () => {
    it('cuts at an attribution the client wrapped onto a second line', () => {
      const raw = [
        'Olur, teşekkürler.',
        '',
        'On Mon, 8 Sep 2026 at 14:02, Hummy Tummy',
        '<admin@hummytummy.com> wrote:',
        '> Merhaba,',
      ].join('\n');
      expect(stripQuotedReply(raw)).toBe('Olur, teşekkürler.');
    });

    it('cuts at a Turkish attribution wrapped over three lines', () => {
      const raw = [
        'Yarın arayın lütfen.',
        '',
        '8 Eyl 2026 Sal, saat 14:02 tarihinde',
        'Hummy Tummy',
        '<admin@hummytummy.com> şunu yazdı:',
        '> Merhaba,',
      ].join('\n');
      expect(stripQuotedReply(raw)).toBe('Yarın arayın lütfen.');
    });

    it('does not swallow prose by joining four lines together', () => {
      // The join is capped at three lines so an ordinary paragraph that happens
      // to end in "wrote:" many lines later cannot become a separator.
      const raw = [
        'On Monday we agreed the price,',
        'then the delivery date,',
        'then the payment terms,',
        'and that is what I wrote:',
        'please confirm.',
      ].join('\n');
      expect(stripQuotedReply(raw)).toBe(raw);
    });
  });

  describe('Outlook header blocks', () => {
    it('detects the Turkish Outlook block', () => {
      const raw = [
        'Tamam, teşekkürler.',
        '',
        'Kimden: Hummy Tummy <admin@hummytummy.com>',
        'Gönderilen: 8 Eylül 2026 Salı 14:02',
        'Kime: Tarık <tarik@musteri.com.tr>',
        'Konu: Teklif',
        '',
        'Merhaba Tarık, ekte teklifimiz.',
      ].join('\n');
      expect(stripQuotedReply(raw)).toBe('Tamam, teşekkürler.');
    });

    it('detects the English Outlook block', () => {
      const raw = [
        'Sounds good.',
        '',
        'From: Hummy Tummy <admin@hummytummy.com>',
        'Sent: Monday, 8 September 2026 14:02',
        'To: Tarik',
        'Subject: Quote',
        '',
        'Hi Tarik,',
      ].join('\n');
      expect(stripQuotedReply(raw)).toBe('Sounds good.');
    });

    it('never cuts a labelled list the customer typed inside a paragraph', () => {
      // Two header-shaped lines, but they continue prose rather than opening a
      // block, so this is a form somebody filled in by hand.
      const raw = ['Aşağıdaki bilgileri gönderiyorum.', 'Kime: Ali Veli', 'Konu: Teklif talebi'].join('\n');
      expect(stripQuotedReply(raw)).toBe(raw);
    });

    it('never cuts on a SINGLE header-shaped line', () => {
      // "Konu: fiyat" is how a person opens a mail, not how Outlook quotes one.
      const raw = 'Konu: fiyat listesi\n\nMerhaba, ekteki listeyi güncelleyebilir misiniz?';
      expect(stripQuotedReply(raw)).toBe(raw);
    });
  });

  describe('the signature delimiter only counts in the tail', () => {
    it('does not cut a long message at an early "--" line', () => {
      const raw = ['Merhaba,', '--', ...Array.from({ length: 20 }, (_, i) => `madde ${i + 1}`)].join('\n');
      expect(stripQuotedReply(raw)).toBe(raw);
    });
  });
});

describe('truncateHtmlQuote', () => {
  it('cuts at the blockquote every client wraps the history in', () => {
    const html = '<div>Evet, olur.</div><blockquote class="x"><p>Merhaba,</p></blockquote>';
    expect(truncateHtmlQuote(html)).toBe('<div>Evet, olur.</div>');
  });

  it('cuts at the Gmail quote container', () => {
    const html = '<div dir="ltr">Olur.</div><div class="gmail_quote"><div>On Mon…</div></div>';
    expect(truncateHtmlQuote(html)).toBe('<div dir="ltr">Olur.</div>');
  });

  it('cuts at the Outlook reply anchors', () => {
    expect(truncateHtmlQuote('<p>Tamam.</p><div id="appendonsend"></div><div>eski</div>')).toBe('<p>Tamam.</p>');
    expect(truncateHtmlQuote('<p>Tamam.</p><div id="divRplyFwdMsg">eski</div>')).toBe('<p>Tamam.</p>');
    expect(truncateHtmlQuote('<p>Tamam.</p><div class="OutlookMessageHeader">eski</div>')).toBe('<p>Tamam.</p>');
  });

  it('cuts at the horizontal rule Outlook puts above a header block', () => {
    const html = '<p>Olur.</p><hr><p><b>Kimden:</b> Hummy Tummy<br><b>Gönderilen:</b> 8 Eylül</p>';
    expect(truncateHtmlQuote(html)).toBe('<p>Olur.</p>');
  });

  it('leaves an ordinary rule alone when no header block follows it', () => {
    const html = '<p>Fiyatlar aşağıda.</p><hr><p>1.200 TL</p>';
    expect(truncateHtmlQuote(html)).toBe(html);
  });

  it('returns the document WHOLE when trimming would leave no words', () => {
    // Same guarantee as the text side: an empty message looks like the customer
    // said nothing, which is worse than showing the quote.
    const html = '<blockquote>Merhaba,</blockquote>';
    expect(truncateHtmlQuote(html)).toBe(html);
  });

  it('passes empty input through untouched', () => {
    expect(truncateHtmlQuote('')).toBe('');
    expect(truncateHtmlQuote(null)).toBe('');
  });
});
