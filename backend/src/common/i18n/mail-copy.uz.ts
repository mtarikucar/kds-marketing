import type { MailCopyKey } from './mail-copy.en';

/**
 * Uzbek (Latin script, matching `frontend/src/i18n/locales/uz`).
 * Recipient-facing copy only, same line as `ar`/`ru`: the `mail.reason.*`
 * lines are operator-facing and fall back to English.
 */
export const uz: Partial<Record<MailCopyKey, string>> = {
  'footer.unsubscribe': 'Obunani bekor qilish',
  'footer.unsubscribeText': 'Obunani bekor qilish: {{url}}',
  'footer.whySending': "Siz bu xatni {{business}} aloqa ro'yxatida bo'lganingiz uchun olyapsiz.",
  'footer.sentTo': 'Bu xat {{email}} manziliga yuborildi.',
  'footer.commercialNotice': 'Bu tijorat elektron xabaridir.',
  'footer.identity.heading': 'Yuboruvchi',
  'footer.identity.tradeName': 'Tijorat nomi: {{value}}',
  'footer.identity.address': 'Manzil: {{value}}',
  'footer.identity.contact': 'Aloqa: {{value}}',

  'unsubscribe.page.title': 'Obunani bekor qilish',
  'unsubscribe.confirm.heading': 'Obunani bekor qilasizmi?',
  'unsubscribe.confirm.body': 'Bu xatlarni olishni to‘xtatish uchun quyidagi tugmani bosing.',
  'unsubscribe.confirm.button': 'Obunani bekor qilish',
  'unsubscribe.done.heading': 'Obunangiz bekor qilindi',
  'unsubscribe.done.body': 'Bundan keyin bu xatlar sizga yuborilmaydi.',
  'unsubscribe.expired.heading': 'Havola muddati tugagan',
  'unsubscribe.expired.body': 'Bu obunani bekor qilish havolasi endi amal qilmaydi.',
  'unsubscribe.error.heading': 'Nimadir xato ketdi',
  'unsubscribe.error.body': 'Hozir buni saqlay olmadik. Iltimos, qayta urinib koʻring.',

  'booking.received.subject': 'Band qilish so‘rovi qabul qilindi: {{calendar}}',
  'booking.received.body': '{{when}} uchun band qilish so‘rovingiz tasdiqlanishini kutmoqda.',
  'booking.confirmed.subject': 'Band qilish tasdiqlandi: {{calendar}}',
  'booking.confirmed.body': 'Band qilishingiz {{when}} uchun tasdiqlandi.',
  'booking.cancelled.subject': 'Band qilish bekor qilindi: {{calendar}}',
  'booking.cancelled.body': '{{when}} sanasidagi band qilishingiz bekor qilindi.',
  'booking.rescheduled.subject': 'Band qilish vaqti o‘zgardi: {{calendar}}',
  'booking.rescheduled.body': 'Band qilishingiz {{when}} vaqtiga ko‘chirildi.',
  'booking.declined.subject': 'Band qilish so‘rovi rad etildi: {{calendar}}',
  'booking.declined.body': '{{when}} uchun band qilish so‘rovingiz tasdiqlanmadi.',
  'booking.reminder.subject': 'Eslatma: band qilgan vaqtingiz yaqinlashdi',
  'booking.reminder.body': 'Bu {{when}} vaqtidagi band qilishingiz uchun eslatma.',
  'booking.hostReminder.subject': 'Eslatma: {{name}} bilan yaqinlashayotgan uchrashuv',
  'booking.hostReminder.body': '{{when}} vaqtida uchrashuvingiz bor.',
  'booking.hostNew.subject': 'Yangi band qilish: {{name}} — {{when}}',
  'booking.hostNew.body': '{{name}} {{when}} uchun {{calendar}} vaqtini band qildi.',
  'booking.calendarLine': 'Taqvim: {{calendar}}',
  'booking.joinLine': 'Qo‘shilish: {{url}}',
  'booking.manageLine': 'Band qilishni boshqarish yoki bekor qilish: {{url}}',
  'booking.fromBusiness': '{{business}} tomonidan yuborildi.',

  'document.greeting': 'Salom, {{name}}!',
  'document.signoff': '{{business}}',
  'document.invoice.subject': '{{business}} hisob-fakturasi: {{number}}',
  'document.invoice.body': '{{business}} sizga {{number}} raqamli hisob-fakturani yubordi.',
  'document.invoice.amountLine': 'To‘lanadigan summa: {{amount}}',
  'document.invoice.dueLine': 'To‘lov muddati: {{date}}',
  'document.invoice.payLine': 'Ko‘rish va to‘lash: {{url}}',
  'document.quote.subject': '{{business}} taklifi: {{number}}',
  'document.quote.body': '{{business}} siz uchun {{number}} raqamli taklifni tayyorladi.',
  'document.quote.totalLine': 'Jami: {{amount}}',
  'document.quote.validUntilLine': 'Amal qilish muddati: {{date}}',
  'document.quote.viewLine': 'Taklifni ko‘rish: {{url}}',
  'document.receipt.subject': '{{number}} raqamli hisob-faktura uchun to‘lov tasdig‘i',
  'document.receipt.body':
    '{{number}} raqamli hisob-faktura bo‘yicha {{amount}} to‘lovingizni oldik. Rahmat.',
  'document.esign.subject': 'Imzoyingiz kutilmoqda: {{title}}',
  'document.esign.body': '{{business}} sizdan {{title}} hujjatini ko‘rib chiqib imzolashni so‘raydi.',
  'document.esign.signLine': 'Ko‘rib chiqish va imzolash: {{url}}',
  'document.esign.signedSubject': 'Imzolangan nusxa: {{title}}',
  'document.esign.signedBody': '{{title}} barcha tomonlar tomonidan imzolandi. Imzolangan nusxani bu yerda koʻrishingiz mumkin:',

  'invite.subject': '{{inviter}} sizni {{workspace}} ish maydoniga taklif qildi',
  'invite.body': '{{inviter}} sizni {{product}} dagi {{workspace}} ish maydoniga taklif qildi.',
  'invite.ctaLine': 'Taklifni qabul qilish: {{url}}',
  'invite.expiryLine': 'Bu taklif {{date}} sanasida muddati tugaydi.',

  'digest.subject': '{{workspace}} — kunlik xulosa ({{date}})',
  'digest.heading': 'Kecha nimalar bo‘lganini jamladik.',
  'digest.ctaLine': '{{product}} ni oching: {{url}}',
  'digest.optOutLine': 'Kunlik xulosani olishni to‘xtatish: {{url}}',

  'auth.reset.subject': 'Parolni tiklash',
  'auth.reset.body':
    'Yangi parol belgilash uchun quyidagi havoladan foydalaning. Havola {{minutes}} daqiqada eskiradi va bir marta ishlaydi.',
  'auth.reset.ctaLine': 'Yangi parol belgilash: {{url}}',
  'auth.reset.ignoreLine': 'Agar buni siz so‘ramagan bo‘lsangiz, bu xatni e’tiborsiz qoldiring.',
  'auth.verify.subject': 'Elektron pochta manzilingizni tasdiqlang',
  'auth.verify.body':
    'Hisobingizni yakunlash uchun bu manzilni tasdiqlang. Havola {{minutes}} daqiqada eskiradi.',
  'auth.verify.ctaLine': 'Manzilni tasdiqlash: {{url}}',
};
