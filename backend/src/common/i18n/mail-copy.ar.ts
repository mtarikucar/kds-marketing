import type { MailCopyKey } from './mail-copy.en';

/**
 * Arabic. Recipient-facing copy only, same line as `ru`/`uz`: the
 * `mail.reason.*` lines are operator-facing and fall back to English.
 *
 * The values carry no directional marks. Mail clients apply the paragraph
 * direction themselves, and an embedded RLM/LRM would show up as a stray
 * character in the plain-text part.
 */
export const ar: Partial<Record<MailCopyKey, string>> = {
  'footer.unsubscribe': 'إلغاء الاشتراك',
  'footer.unsubscribeText': 'لإلغاء الاشتراك: {{url}}',
  'footer.whySending': 'تصلك هذه الرسالة لأنك مدرج في قائمة جهات اتصال {{business}}.',
  'footer.sentTo': 'أُرسلت هذه الرسالة إلى {{email}}.',
  'footer.commercialNotice': 'هذه رسالة إلكترونية تجارية.',
  'footer.identity.heading': 'المرسل',
  'footer.identity.tradeName': 'الاسم التجاري: {{value}}',
  'footer.identity.address': 'العنوان: {{value}}',
  'footer.identity.contact': 'جهة الاتصال: {{value}}',

  'unsubscribe.page.title': 'إلغاء الاشتراك',
  'unsubscribe.confirm.heading': 'هل تريد إلغاء الاشتراك؟',
  'unsubscribe.confirm.body': 'اضغط الزر أدناه للتوقف عن استلام هذه الرسائل.',
  'unsubscribe.confirm.button': 'إلغاء الاشتراك',
  'unsubscribe.done.heading': 'تم إلغاء اشتراكك',
  'unsubscribe.done.body': 'لن تصلك هذه الرسائل بعد الآن.',
  'unsubscribe.expired.heading': 'انتهت صلاحية الرابط',
  'unsubscribe.expired.body': 'لم يعد رابط إلغاء الاشتراك هذا صالحًا.',
  'unsubscribe.error.heading': 'حدث خطأ ما',
  'unsubscribe.error.body': 'تعذّر تسجيل ذلك الآن. يُرجى المحاولة مرة أخرى.',

  'booking.received.subject': 'تم استلام طلب الحجز: {{calendar}}',
  'booking.received.body': 'طلب حجزك في {{when}} بانتظار الموافقة.',
  'booking.confirmed.subject': 'تم تأكيد الحجز: {{calendar}}',
  'booking.confirmed.body': 'تم تأكيد حجزك في {{when}}.',
  'booking.cancelled.subject': 'تم إلغاء الحجز: {{calendar}}',
  'booking.cancelled.body': 'تم إلغاء حجزك في {{when}}.',
  'booking.rescheduled.subject': 'تم تغيير موعد الحجز: {{calendar}}',
  'booking.rescheduled.body': 'تم نقل حجزك إلى {{when}}.',
  'booking.declined.subject': 'لم تتم الموافقة على طلب الحجز: {{calendar}}',
  'booking.declined.body': 'لم تتم الموافقة على طلب حجزك في {{when}}.',
  'booking.reminder.subject': 'تذكير: اقترب موعد حجزك',
  'booking.reminder.body': 'هذا تذكير بحجزك في {{when}}.',
  'booking.hostReminder.subject': 'تذكير: موعد قادم مع {{name}}',
  'booking.hostReminder.body': 'لديك موعد في {{when}}.',
  'booking.hostNew.subject': 'حجز جديد: {{name}} — {{when}}',
  'booking.hostNew.body': 'حجز {{name}} موعد {{calendar}} في {{when}}.',
  'booking.calendarLine': 'التقويم: {{calendar}}',
  'booking.joinLine': 'انضم: {{url}}',
  'booking.manageLine': 'لإدارة حجزك أو إلغائه: {{url}}',
  'booking.fromBusiness': 'أُرسلت من {{business}}.',

  // ── صفحة إدارة الموعد / إلغائه ────────────────────────────────────────────
  'booking.manage.title': 'الموعد',
  'booking.manage.join': 'انضم إلى الاجتماع',
  'booking.manage.cancelled': 'تم إلغاء هذا الموعد.',
  'booking.manage.rebook': 'اختر وقتًا جديدًا',
  'booking.manage.cancel': 'إلغاء الموعد',
  'booking.manage.reschedule': 'تغيير الوقت',
  'booking.manage.cancelDone': 'تم إلغاء موعدك.',
  'booking.manage.cancelFailed': 'تعذّر الإلغاء. يُرجى المحاولة مرة أخرى.',
  'booking.manage.notFound.heading': 'الموعد غير موجود',
  'booking.manage.notFound.body': 'لم يعد هذا الرابط صالحًا.',

  'document.greeting': 'مرحبًا {{name}}،',
  'document.signoff': '{{business}}',
  'document.invoice.subject': 'فاتورة {{number}} من {{business}}',
  'document.invoice.body': 'أرسلت {{business}} إليك الفاتورة {{number}}.',
  'document.invoice.amountLine': 'المبلغ المستحق: {{amount}}',
  'document.invoice.dueLine': 'تاريخ الاستحقاق: {{date}}',
  'document.invoice.payLine': 'للعرض والدفع: {{url}}',
  'document.quote.subject': 'عرض سعر {{number}} من {{business}}',
  'document.quote.body': 'أعدت {{business}} لك عرض السعر {{number}}.',
  'document.quote.totalLine': 'الإجمالي: {{amount}}',
  'document.quote.validUntilLine': 'صالح حتى: {{date}}',
  'document.quote.viewLine': 'لعرض عرض السعر: {{url}}',
  'document.receipt.subject': 'إيصال الفاتورة {{number}}',
  'document.receipt.body': 'استلمنا دفعتك بمبلغ {{amount}} عن الفاتورة {{number}}. شكرًا لك.',
  'document.esign.subject': 'مطلوب توقيعك: {{title}}',
  'document.esign.body': 'تطلب منك {{business}} مراجعة {{title}} وتوقيعه.',
  'document.esign.signLine': 'للمراجعة والتوقيع: {{url}}',
  'document.esign.signedSubject': 'نسخة موقعة: {{title}}',
  'document.esign.signedBody': 'تم توقيع {{title}} من جميع الأطراف. يمكنك عرض النسخة الموقّعة هنا:',

  'invite.subject': 'دعاك {{inviter}} للانضمام إلى {{workspace}}',
  'invite.body': 'دعاك {{inviter}} للانضمام إلى مساحة العمل {{workspace}} على {{product}}.',
  'invite.ctaLine': 'لقبول الدعوة: {{url}}',
  'invite.expiryLine': 'تنتهي صلاحية هذه الدعوة في {{date}}.',

  'digest.subject': '{{workspace}} — الملخص اليومي ({{date}})',
  'digest.heading': 'إليك ما حدث أمس.',
  'digest.ctaLine': 'افتح {{product}}: {{url}}',
  'digest.optOutLine': 'لإيقاف الملخص اليومي: {{url}}',

  'auth.reset.subject': 'إعادة تعيين كلمة المرور',
  'auth.reset.body':
    'استخدم الرابط أدناه لتعيين كلمة مرور جديدة. تنتهي صلاحيته خلال {{minutes}} دقيقة ويُستخدم مرة واحدة.',
  'auth.reset.ctaLine': 'لتعيين كلمة مرور جديدة: {{url}}',
  'auth.reset.ignoreLine': 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.',
  'auth.verify.subject': 'أكد عنوان بريدك الإلكتروني',
  'auth.verify.body':
    'أكد هذا العنوان لإكمال إعداد حسابك. تنتهي صلاحية الرابط خلال {{minutes}} دقيقة.',
  'auth.verify.ctaLine': 'لتأكيد عنوانك: {{url}}',
};
