import { useTranslation } from 'react-i18next';

// The prospect workspace's own words (spec 2026-11-10-prospects-pool-redesign-design.md). The
// labels the pool already had (statuses, fields, reasons, dialogs) stay in the i18n files.

const tr = {
  thisMonth: 'Bu ay', found: 'bulundu', qualified: 'nitelikli', inContact: 'iletişimde', replied: 'yanıt verdi', won: 'satış',
  funnel: 'Bu ayın hunisi',
  tabs: 'Durum', tabAll: 'Tümü', tabNew: 'Yeni', tabQualified: 'Nitelikli', tabContact: 'İletişimde', tabRejected: 'Reddedilen', tabBlocked: 'Yasaklı',
  playbook: 'Ajan talimatları', listLabel: 'Adaylar', score: 'Puan {score}', noScore: 'Puansız',
  choose: 'Soldan bir aday seç.', chooseBody: 'Notları, akışı ve iletişim bilgileri burada açılır.',
  back: 'Aday havuzu', more: 'Diğer işlemler', openConversation: 'Konuşmayı aç',
  notes: 'Notlar', edit: 'Düzenle', addNote: 'Not ekle', noNotes: 'Henüz not yok.',
  noNotesBody: 'Araştırma notunu ya da kendi gözlemini buraya yaz.', save: 'Kaydet', cancel: 'Vazgeç',
  notesSaved: 'Notlar kaydedildi.', notesField: 'Not metni', notesLeft: '{n} karakter kaldı',
  notesLocked: 'İletişime geçilen adayın yeni notları gelen kutusundaki süreçte tutulur.',
  timeline: 'Akış', showAll: 'Tümünü göster ({n})', showLess: 'Daha az göster', noTimeline: 'Henüz kayıt yok.',
  contact: 'İletişim', noContact: 'İletişim bilgisi yok.', business: 'İşletme', scoreCard: 'Puan', record: 'Kayıt',
  scoreOf: '{score} / 100', threshold: 'Nitelik eşiği {n}', olderRubric: 'Eski ölçütlerle puanlandı.',
  steps: 'Aşama', stepFound: 'Bulundu', stepScored: 'Puanlandı', stepQualified: 'Nitelikli', stepContacted: 'Mesaj atıldı',
  stepReplied: 'Yanıt', stepMeeting: 'Görüşme', stepWon: 'Satış', stepDone: 'tamam', stepNow: 'şu an', stepNext: 'sırada',
  closedRejected: 'Reddedildi', closedBlocked: 'İletişim yasağı', closedLost: 'Kaybedildi',
  // Timeline entries.
  tlCreated: '{who} kaydetti', tlUpdated: '{who} bilgileri güncelledi', tlNotes: '{who} notları güncelledi',
  tlScored: 'Puanlandı: {score}', tlQualifiedAuto: 'Nitelikli sayıldı', tlQualifiedAutoBody: 'otomatik · puan {score}',
  tlQualified: '{who} nitelikli saydı', tlRejected: '{who} reddetti', tlReopened: '{who} yeniden açtı',
  tlPromoted: 'İletişime alındı', tlPromotedBody: 'Gelen kutusunda süreci açıldı',
  tlBlocked: 'İletişim yasağı kondu', tlUnblocked: 'İletişim yasağı kaldırıldı', tlErased: 'Kişisel veriler silindi',
  tlMessageIn: 'Mesaj geldi', tlMessageOut: 'Mesaj gönderildi', tlOutreach: 'Kampanya e-postası gitti', tlOutreachBody: '{n}. adım',
  tlCallOk: 'Arandı, görüşüldü', tlCallMiss: 'Arandı, ulaşılamadı', tlAppointment: 'Randevu alındı', tlMeeting: 'Görüşme yapıldı',
  tlQuote: 'Teklif gönderildi', tlQuoteOk: 'Teklif kabul edildi', tlWon: 'Satış kazanıldı', tlLost: 'Kaybedildi',
  tlSnoozed: 'Ertelendi', tlJourneyReopened: 'Süreç yeniden açıldı', tlMerged: 'Başka bir kişiyle birleştirildi',
  tlNote: '{who} not ekledi', tlHandoff: '{who} {way} üzerinden yazdı', tlOther: 'Kayıt',
  system: 'Sistem', agent: 'Ajan', someone: 'Ekip üyesi',
  task: 'Görev: {label}',
  // "Mesaj gönder".
  sendMessage: 'Mesaj gönder', msgTitle: '{name} için mesaj', msgChannel: 'Kanal',
  wayEmail: 'E-posta', waySms: 'SMS', wayWhatsapp: 'WhatsApp', wayInstagram: 'Instagram',
  viaAccount: '“{name}” üzerinden gönderilir',
  handoffWhatsapp: 'WhatsApp açılır, mesaj hazır gelir; gönder tuşuna sen basarsın.',
  handoffInstagram: 'Mesaj panoya kopyalanır, Instagram mesajları açılır; yapıştırıp gönderirsin.',
  noEmail: 'E-posta adresi yok', noPhone: 'Telefon numarası yok', noHandle: 'Instagram hesabı yok',
  noMailbox: 'Bağlı ve doğrulanmış e-posta kutusu yok', noSmsLine: 'Bağlı ve doğrulanmış SMS hattı yok',
  basisOff: 'Bu kanalda işletmelere ilk mesaj izni kapalı', platformOff: 'Sunucuda soğuk gönderim kapalı',
  identityMissing: 'Gönderen kimliği eksik: şirket adı, adres ve gizlilik bağlantısı', fillIdentity: 'Tamamla',
  openBasis: 'İzni aç', connectChannel: 'Kanal bağla',
  subject: 'Konu', message: 'Mesaj', chars: '{n} karakter',
  afterSend: 'Gönderince aday “İletişimde” durumuna geçer; yanıtı Gelen kutusunda görürsün.',
  send: 'Gönder', openWhatsapp: 'Hazırla ve WhatsApp’ı aç', openInstagram: 'Kopyala ve Instagram’ı aç',
  sent: 'Mesaj gönderildi.', queued: 'Mesaj sıraya alındı.', held: 'Mesaj onay bekliyor.', sendState: 'Mesajın durumu: {state}',
  handedOff: '{way} açıldı; mesajı oradan gönder.',
  popupBlocked: 'Tarayıcı yeni sekmeyi engelledi. Aday iletişime alındı; sohbeti buradan aç:', openLink: '{way} sohbetini aç',
  noPermission: 'Bu alıcıya bu kanaldan ticari mesaj izni yok. Kampanya ayarlarından “işletme alıcısı dayanağını” bu kanal için açabilirsin.',
  noWay: 'Bu adaya ulaşılabilecek bir kanal yok.',
};

const en: typeof tr = {
  thisMonth: 'This month', found: 'found', qualified: 'qualified', inContact: 'in contact', replied: 'replied', won: 'won',
  funnel: 'This month’s funnel',
  tabs: 'Status', tabAll: 'All', tabNew: 'New', tabQualified: 'Qualified', tabContact: 'In contact', tabRejected: 'Rejected', tabBlocked: 'Blocked',
  playbook: 'Agent instructions', listLabel: 'Prospects', score: 'Score {score}', noScore: 'Unscored',
  choose: 'Choose a prospect on the left.', chooseBody: 'Its notes, timeline and contact details open here.',
  back: 'Prospect pool', more: 'More actions', openConversation: 'Open conversation',
  notes: 'Notes', edit: 'Edit', addNote: 'Add a note', noNotes: 'No notes yet.',
  noNotesBody: 'Write the research note or your own observation here.', save: 'Save', cancel: 'Cancel',
  notesSaved: 'Notes saved.', notesField: 'Note text', notesLeft: '{n} characters left',
  notesLocked: 'Once in contact, new notes are kept on the journey in the inbox.',
  timeline: 'Timeline', showAll: 'Show all ({n})', showLess: 'Show less', noTimeline: 'Nothing recorded yet.',
  contact: 'Contact', noContact: 'No contact details.', business: 'Business', scoreCard: 'Score', record: 'Record',
  scoreOf: '{score} / 100', threshold: 'Qualifies at {n}', olderRubric: 'Scored under an older rubric.',
  steps: 'Stage', stepFound: 'Found', stepScored: 'Scored', stepQualified: 'Qualified', stepContacted: 'Messaged',
  stepReplied: 'Reply', stepMeeting: 'Meeting', stepWon: 'Won', stepDone: 'done', stepNow: 'now', stepNext: 'next',
  closedRejected: 'Rejected', closedBlocked: 'Do not contact', closedLost: 'Lost',
  tlCreated: '{who} recorded it', tlUpdated: '{who} updated the details', tlNotes: '{who} updated the notes',
  tlScored: 'Scored: {score}', tlQualifiedAuto: 'Counted as qualified', tlQualifiedAutoBody: 'automatic · score {score}',
  tlQualified: '{who} qualified it', tlRejected: '{who} rejected it', tlReopened: '{who} reopened it',
  tlPromoted: 'Taken into contact', tlPromotedBody: 'Its journey opened in the inbox',
  tlBlocked: 'Marked do not contact', tlUnblocked: 'Do-not-contact lifted', tlErased: 'Personal data erased',
  tlMessageIn: 'Message received', tlMessageOut: 'Message sent', tlOutreach: 'Campaign email sent', tlOutreachBody: 'step {n}',
  tlCallOk: 'Called, connected', tlCallMiss: 'Called, no answer', tlAppointment: 'Appointment booked', tlMeeting: 'Meeting held',
  tlQuote: 'Quote sent', tlQuoteOk: 'Quote accepted', tlWon: 'Sale won', tlLost: 'Lost',
  tlSnoozed: 'Snoozed', tlJourneyReopened: 'Journey reopened', tlMerged: 'Merged with another person',
  tlNote: '{who} added a note', tlHandoff: '{who} wrote on {way}', tlOther: 'Entry',
  system: 'System', agent: 'Agent', someone: 'Team member',
  task: 'Task: {label}',
  sendMessage: 'Send message', msgTitle: 'Message to {name}', msgChannel: 'Channel',
  wayEmail: 'Email', waySms: 'SMS', wayWhatsapp: 'WhatsApp', wayInstagram: 'Instagram',
  viaAccount: 'Sent through “{name}”',
  handoffWhatsapp: 'WhatsApp opens with the message ready; you press send.',
  handoffInstagram: 'The message is copied and Instagram messages open; paste it and send.',
  noEmail: 'No email address', noPhone: 'No phone number', noHandle: 'No Instagram account',
  noMailbox: 'No connected, verified mailbox', noSmsLine: 'No connected, verified SMS line',
  basisOff: 'First messages to businesses are off on this channel', platformOff: 'Cold sending is off on the server',
  identityMissing: 'The sender identity is incomplete: company, address and privacy link', fillIdentity: 'Complete it',
  openBasis: 'Open it', connectChannel: 'Connect a channel',
  subject: 'Subject', message: 'Message', chars: '{n} characters',
  afterSend: 'On sending, the prospect moves to “In contact”; the reply shows in the inbox.',
  send: 'Send', openWhatsapp: 'Prepare and open WhatsApp', openInstagram: 'Copy and open Instagram',
  sent: 'Message sent.', queued: 'Message queued.', held: 'Message awaits approval.', sendState: 'The message is: {state}',
  handedOff: '{way} opened; send the message there.',
  popupBlocked: 'The browser blocked the new tab. The prospect is in contact; open the chat here:', openLink: 'Open the {way} chat',
  noPermission: 'There is no permission for a commercial message to this recipient on this channel. Open the “business-recipient basis” for it in the campaign settings.',
  noWay: 'There is no channel to reach this prospect on.',
};

export type PoolCopyKey = keyof typeof tr;
export type PoolCopy = ((key: PoolCopyKey, vars?: Record<string, string | number>) => string) & { isTurkish: boolean };

export function usePoolCopy(): PoolCopy {
  const { i18n } = useTranslation();
  const isTurkish = (i18n.resolvedLanguage ?? i18n.language).startsWith('tr');
  const table = isTurkish ? tr : en;
  const copy = ((key: PoolCopyKey, vars: Record<string, string | number> = {}) =>
    table[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))) as PoolCopy;
  copy.isTurkish = isTurkish;
  return copy;
}
