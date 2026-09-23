import type { MailCopyKey } from './mail-copy.en';

/**
 * Russian. Recipient-facing copy only — everything a customer or a workspace
 * member reads. The `mail.reason.*` lines are deliberately absent: they are
 * operator-facing, the tenant UI renders them from its own dictionary, and an
 * English line there degrades gracefully where a bad translation would not.
 * That gap is what `t()`'s English fallback is for, and the spec pins it.
 */
export const ru: Partial<Record<MailCopyKey, string>> = {
  'footer.unsubscribe': 'Отписаться',
  'footer.unsubscribeText': 'Отписаться: {{url}}',
  'footer.whySending': 'Вы получаете это письмо, так как состоите в списке контактов {{business}}.',
  'footer.sentTo': 'Это письмо отправлено на адрес {{email}}.',
  'footer.commercialNotice': 'Это коммерческое электронное сообщение.',
  'footer.identity.heading': 'Отправитель',
  'footer.identity.tradeName': 'Наименование: {{value}}',
  'footer.identity.address': 'Адрес: {{value}}',
  'footer.identity.contact': 'Контакты: {{value}}',

  'unsubscribe.page.title': 'Отписаться',
  'unsubscribe.confirm.heading': 'Отписаться от рассылки?',
  'unsubscribe.confirm.body': 'Нажмите кнопку ниже, чтобы больше не получать эти письма.',
  'unsubscribe.confirm.button': 'Отписаться',
  'unsubscribe.done.heading': 'Вы отписались',
  'unsubscribe.done.body': 'Вы больше не будете получать эти письма.',
  'unsubscribe.expired.heading': 'Ссылка недействительна',
  'unsubscribe.expired.body': 'Эта ссылка для отписки больше не действует.',
  'unsubscribe.error.heading': 'Что-то пошло не так',
  'unsubscribe.error.body': 'Сейчас не удалось это сохранить. Пожалуйста, попробуйте ещё раз.',

  'booking.received.subject': 'Заявка на запись получена: {{calendar}}',
  'booking.received.body': 'Ваша заявка на запись на {{when}} ожидает подтверждения.',
  'booking.confirmed.subject': 'Запись подтверждена: {{calendar}}',
  'booking.confirmed.body': 'Ваша запись подтверждена на {{when}}.',
  'booking.cancelled.subject': 'Запись отменена: {{calendar}}',
  'booking.cancelled.body': 'Ваша запись на {{when}} отменена.',
  'booking.rescheduled.subject': 'Запись перенесена: {{calendar}}',
  'booking.rescheduled.body': 'Ваша запись перенесена на {{when}}.',
  'booking.declined.subject': 'Заявка на запись отклонена: {{calendar}}',
  'booking.declined.body': 'Ваша заявка на запись на {{when}} не была подтверждена.',
  'booking.reminder.subject': 'Напоминание: ваша запись скоро',
  'booking.reminder.body': 'Напоминаем о вашей записи на {{when}}.',
  'booking.hostReminder.subject': 'Напоминание: предстоящая встреча с {{name}}',
  'booking.hostReminder.body': 'У вас встреча {{when}}.',
  'booking.hostNew.subject': 'Новая запись: {{name}} — {{when}}',
  'booking.hostNew.body': '{{name}} записался(ась) на {{calendar}} на {{when}}.',
  'booking.calendarLine': 'Календарь: {{calendar}}',
  'booking.joinLine': 'Подключиться: {{url}}',
  'booking.manageLine': 'Изменить или отменить запись: {{url}}',
  'booking.fromBusiness': 'Отправлено {{business}}.',

  // ── Страница управления записью / её отмены ───────────────────────────────
  'booking.manage.title': 'Запись',
  'booking.manage.join': 'Присоединиться к встрече',
  'booking.manage.cancelled': 'Эта запись отменена.',
  'booking.manage.rebook': 'Выбрать другое время',
  'booking.manage.cancel': 'Отменить запись',
  'booking.manage.reschedule': 'Изменить время',
  'booking.manage.cancelDone': 'Ваша запись отменена.',
  'booking.manage.cancelFailed': 'Не удалось отменить. Пожалуйста, попробуйте ещё раз.',
  'booking.manage.notFound.heading': 'Запись не найдена',
  'booking.manage.notFound.body': 'Эта ссылка больше не действует.',

  'document.greeting': 'Здравствуйте, {{name}}!',
  'document.signoff': '{{business}}',
  'document.invoice.subject': 'Счёт {{number}} от {{business}}',
  'document.invoice.body': '{{business}} выставил(а) вам счёт {{number}}.',
  'document.invoice.amountLine': 'Сумма к оплате: {{amount}}',
  'document.invoice.dueLine': 'Срок оплаты: {{date}}',
  'document.invoice.payLine': 'Посмотреть и оплатить: {{url}}',
  'document.quote.subject': 'Коммерческое предложение {{number}} от {{business}}',
  'document.quote.body': '{{business}} подготовил(а) для вас предложение {{number}}.',
  'document.quote.totalLine': 'Итого: {{amount}}',
  'document.quote.validUntilLine': 'Действительно до: {{date}}',
  'document.quote.viewLine': 'Посмотреть предложение: {{url}}',
  'document.receipt.subject': 'Подтверждение оплаты счёта {{number}}',
  'document.receipt.body': 'Мы получили вашу оплату {{amount}} по счёту {{number}}. Спасибо.',
  'document.esign.subject': 'Требуется подпись: {{title}}',
  'document.esign.body': '{{business}} просит вас ознакомиться с документом {{title}} и подписать его.',
  'document.esign.signLine': 'Ознакомиться и подписать: {{url}}',
  'document.esign.signedSubject': 'Подписанный документ: {{title}}',
  'document.esign.signedBody': 'Документ {{title}} подписан всеми сторонами. Подписанную копию можно посмотреть здесь:',

  'invite.subject': '{{inviter}} приглашает вас в {{workspace}}',
  'invite.body': '{{inviter}} приглашает вас в рабочее пространство {{workspace}} в {{product}}.',
  'invite.ctaLine': 'Принять приглашение: {{url}}',
  'invite.expiryLine': 'Приглашение действует до {{date}}.',

  'digest.subject': '{{workspace}} — сводка за день ({{date}})',
  'digest.heading': 'Вот что произошло вчера.',
  'digest.ctaLine': 'Открыть {{product}}: {{url}}',
  'digest.optOutLine': 'Отключить ежедневную сводку: {{url}}',

  'auth.reset.subject': 'Сброс пароля',
  'auth.reset.body':
    'Перейдите по ссылке ниже, чтобы задать новый пароль. Ссылка действует {{minutes}} минут и работает один раз.',
  'auth.reset.ctaLine': 'Задать новый пароль: {{url}}',
  'auth.reset.ignoreLine': 'Если вы не запрашивали смену пароля, просто не обращайте внимания на это письмо.',
  'auth.verify.subject': 'Подтвердите адрес электронной почты',
  'auth.verify.body':
    'Подтвердите этот адрес, чтобы завершить создание учётной записи. Ссылка действует {{minutes}} минут.',
  'auth.verify.ctaLine': 'Подтвердить адрес: {{url}}',
};
