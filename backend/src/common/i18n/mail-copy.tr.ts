import type { MailCopyKey } from './mail-copy.en';

/**
 * Turkish. The primary market, so this dictionary is COMPLETE — the type below
 * makes a missing line a compile error, and `mail-copy.spec.ts` asserts it
 * again at runtime. Turkish recipients falling back to English is the exact
 * defect this module exists to fix.
 */
export const tr: Record<MailCopyKey, string> = {
  'footer.unsubscribe': 'Abonelikten çık',
  'footer.unsubscribeText': 'Abonelikten çıkmak için: {{url}}',
  'footer.whySending': 'Bu iletiyi {{business}} iletişim listesinde yer aldığınız için alıyorsunuz.',
  'footer.sentTo': 'Bu ileti {{email}} adresine gönderildi.',
  'footer.commercialNotice': 'Bu bir ticari elektronik iletidir.',
  'footer.identity.heading': 'Gönderen',
  'footer.identity.tradeName': 'Ticari unvan: {{value}}',
  'footer.identity.address': 'Adres: {{value}}',
  'footer.identity.contact': 'İletişim: {{value}}',

  'unsubscribe.page.title': 'Abonelikten çık',
  'unsubscribe.confirm.heading': 'Abonelikten çıkmak istiyor musunuz?',
  'unsubscribe.confirm.body': 'Bu iletileri almayı durdurmak için aşağıdaki düğmeye basın.',
  'unsubscribe.confirm.button': 'Abonelikten çık',
  'unsubscribe.done.heading': 'Abonelikten çıkarıldınız',
  'unsubscribe.done.body': 'Bundan sonra bu iletileri almayacaksınız.',
  'unsubscribe.expired.heading': 'Bağlantının süresi dolmuş',
  'unsubscribe.expired.body': 'Bu abonelikten çıkma bağlantısı artık geçerli değil.',
  'unsubscribe.error.heading': 'Bir şeyler ters gitti',
  'unsubscribe.error.body': 'Şu anda kaydedemedik, lütfen tekrar deneyin.',

  'booking.received.subject': 'Randevu talebiniz alındı: {{calendar}}',
  'booking.received.body': '{{when}} için randevu talebiniz onay bekliyor.',
  'booking.confirmed.subject': 'Randevunuz onaylandı: {{calendar}}',
  'booking.confirmed.body': 'Randevunuz {{when}} için onaylandı.',
  'booking.cancelled.subject': 'Randevunuz iptal edildi: {{calendar}}',
  'booking.cancelled.body': '{{when}} tarihli randevunuz iptal edildi.',
  'booking.rescheduled.subject': 'Randevunuz ertelendi: {{calendar}}',
  'booking.rescheduled.body': 'Randevunuz {{when}} tarihine alındı.',
  'booking.declined.subject': 'Randevu talebiniz onaylanmadı: {{calendar}}',
  'booking.declined.body': '{{when}} için randevu talebiniz onaylanmadı.',
  'booking.reminder.subject': 'Hatırlatma: randevunuz yaklaşıyor',
  'booking.reminder.body': '{{when}} tarihli randevunuz için hatırlatmadır.',
  'booking.hostReminder.subject': 'Hatırlatma: {{name}} ile yaklaşan randevu',
  'booking.hostReminder.body': '{{when}} tarihinde bir randevunuz var.',
  'booking.hostNew.subject': 'Yeni randevu: {{name}} — {{when}}',
  'booking.hostNew.body': '{{name}}, {{when}} için {{calendar}} randevusu oluşturdu.',
  'booking.calendarLine': 'Takvim: {{calendar}}',
  'booking.joinLine': 'Katıl: {{url}}',
  'booking.manageLine': 'Randevunuzu yönetmek veya iptal etmek için: {{url}}',
  'booking.fromBusiness': '{{business}} tarafından gönderildi.',

  // ── Randevu yönetme/iptal sayfası ─────────────────────────────────────────
  'booking.manage.title': 'Randevu',
  'booking.manage.join': 'Toplantıya katıl',
  'booking.manage.cancelled': 'Bu randevu iptal edildi.',
  'booking.manage.rebook': 'Yeni bir saat seç',
  'booking.manage.cancel': 'Randevuyu iptal et',
  'booking.manage.reschedule': 'Saati değiştir',
  'booking.manage.cancelDone': 'Randevunuz iptal edildi.',
  'booking.manage.cancelFailed': 'İptal edilemedi, lütfen tekrar deneyin.',
  'booking.manage.notFound.heading': 'Randevu bulunamadı',
  'booking.manage.notFound.body': 'Bu bağlantı artık geçerli değil.',

  'document.greeting': 'Merhaba {{name}},',
  'document.signoff': '{{business}}',
  'document.invoice.subject': '{{business}} faturası: {{number}}',
  'document.invoice.body': '{{business}}, {{number}} numaralı faturayı gönderdi.',
  'document.invoice.amountLine': 'Ödenecek tutar: {{amount}}',
  'document.invoice.dueLine': 'Son ödeme tarihi: {{date}}',
  'document.invoice.payLine': 'Görüntülemek ve ödemek için: {{url}}',
  'document.quote.subject': '{{business}} teklifi: {{number}}',
  'document.quote.body': '{{business}}, sizin için {{number}} numaralı teklifi hazırladı.',
  'document.quote.totalLine': 'Toplam: {{amount}}',
  'document.quote.validUntilLine': 'Son geçerlilik tarihi: {{date}}',
  'document.quote.viewLine': 'Teklifi görüntülemek için: {{url}}',
  'document.receipt.subject': '{{number}} numaralı fatura için tahsilat bilgisi',
  'document.receipt.body':
    '{{number}} numaralı fatura için {{amount}} tutarındaki ödemenizi aldık. Teşekkür ederiz.',
  'document.esign.subject': 'İmzanız bekleniyor: {{title}}',
  'document.esign.body': '{{business}}, {{title}} belgesini incelemenizi ve imzalamanızı istiyor.',
  'document.esign.signLine': 'İncelemek ve imzalamak için: {{url}}',
  'document.esign.signedSubject': 'İmzalı kopya: {{title}}',
  'document.esign.signedBody': '{{title}} tüm taraflarca imzalandı. İmzalı kopyayı buradan görüntüleyebilirsiniz:',

  'invite.subject': '{{inviter}} sizi {{workspace}} çalışma alanına davet etti',
  'invite.body':
    '{{inviter}}, sizi {{product}} üzerindeki {{workspace}} çalışma alanına davet etti.',
  'invite.ctaLine': 'Daveti kabul etmek için: {{url}}',
  'invite.expiryLine': 'Bu davetin süresi {{date}} tarihinde doluyor.',

  'digest.subject': '{{workspace}} — günlük özet ({{date}})',
  'digest.heading': 'Dün neler olduğunu özetledik.',
  'digest.ctaLine': '{{product}} uygulamasını açın: {{url}}',
  'digest.optOutLine': 'Günlük özeti almayı durdurmak için: {{url}}',

  'auth.reset.subject': 'Parolanızı sıfırlayın',
  'auth.reset.body':
    'Yeni bir parola belirlemek için aşağıdaki bağlantıyı kullanın. Bağlantı {{minutes}} dakika içinde geçersiz olur ve yalnızca bir kez kullanılabilir.',
  'auth.reset.ctaLine': 'Yeni parola belirlemek için: {{url}}',
  'auth.reset.ignoreLine': 'Bu talebi siz yapmadıysanız bu iletiyi yok sayabilirsiniz.',
  'auth.verify.subject': 'E-posta adresinizi doğrulayın',
  'auth.verify.body':
    'Hesabınızı tamamlamak için bu adresi doğrulayın. Bağlantı {{minutes}} dakika içinde geçersiz olur.',
  'auth.verify.ctaLine': 'Adresinizi doğrulamak için: {{url}}',

  'mail.reason.SUPPRESSED_OPT_OUT': 'Kişi pazarlama e-postalarından çıktı.',
  'mail.reason.SUPPRESSED_BOUNCE':
    'Adres kalıcı olarak geri döndü, bu yüzden artık gönderim yapılmıyor.',
  'mail.reason.SUPPRESSED_INVALID': 'Adres teslim edilebilir değil.',
  'mail.reason.SUPPRESSED_COMPLAINT': 'Kişi önceki iletiyi spam olarak işaretledi.',
  'mail.reason.SUPPRESSED_ERASED': 'Kişi verilerinin silinmesini istedi.',
  'mail.reason.IYS_RET': 'İYS bu adres için ret kaydı tutuyor.',
  'mail.reason.CONSENT_REQUIRED': 'Pazarlama e-postası için onay kaydı yok.',
  'mail.reason.QUOTA_EXHAUSTED': 'Aylık ileti kotası doldu.',
  'mail.reason.DAILY_CAP': 'Bu çalışma alanının günlük gönderim sınırına ulaşıldı.',
  'mail.reason.QUIET_HOURS': 'Gönderime izin verilen saatlerin dışında.',
  'mail.reason.WORKSPACE_INACTIVE': 'Çalışma alanı etkin değil.',
  'mail.reason.SENDING_PAUSED': 'Bu çalışma alanında e-posta gönderimi duraklatıldı.',
  'mail.reason.NO_RECIPIENT': 'Alıcı adresi yok.',
  'mail.reason.BAD_RECIPIENT': 'Alıcı tek ve geçerli bir adres değil.',
  'mail.reason.NO_UNSUBSCRIBE':
    'Toplu e-posta için abonelikten çıkma bağlantısı gerekir; oluşturulamadı.',
  'mail.reason.MISSING_PUBLIC_BASE_URL':
    'PUBLIC_BASE_URL tanımlı değil, abonelikten çıkma bağlantısı kurulamıyor.',
  'mail.reason.NOT_CONFIGURED': 'Yapılandırılmış bir posta kutusu veya platform göndericisi yok.',
  'mail.reason.TRANSIENT': 'Posta sunucusu şimdilik kabul etmedi; yeniden denenecek.',
  'mail.reason.SYSTEMIC': 'Posta sunucusu bağlantıyı veya oturum açmayı reddetti.',
  'mail.reason.PERMANENT': 'Posta sunucusu kalıcı olarak reddetti.',
};
