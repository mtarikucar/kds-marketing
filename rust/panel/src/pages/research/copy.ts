import { useTranslation } from 'react-i18next';

// The research tasks page's own words (the pool's sibling; its words live beside the pool's in
// `../prospects/copy.ts`, the same way). Errors the server names keep their `leads.errors.*` copy.

const tr = {
  // The module's two pages.
  navLabel: 'Aday havuzu bölümleri', navProspects: 'Adaylar', navTasks: 'Araştırma görevleri',
  newTask: 'Yeni görev',
  // The list and its filter.
  listLabel: 'Araştırma görevleri', filterLabel: 'Görevler', open: 'Açık', closed: 'Kapanan',
  oneOff: 'Tek seferlik', fromKnowledge: 'Bilgi bankasından', moreItems: '+{n}',
  cities: '{n} şehir', districts: '{city} · {n} ilçe',
  foundWord: 'bulundu', qualified: '{n} nitelikli',
  today: 'bugün {n}/{cap}', lastFound: 'son aday {when}', noneYet: 'henüz aday yok',
  heldByAgent: '{name} bu görevde · bitiş {until}', heldByYou: 'Sen bu görevdesin · bitiş {until}',
  heldByMember: '{name} bu görevde · bitiş {until}', waiting: 'Bir ajanın alması bekleniyor',
  doneToday: 'Bugünlük tamam', pausedToday: 'Bugün yeni aday beklenmiyor',
  closedDone: 'Tamamlandı · {when}', closedCanceled: 'İptal edildi · {when}',
  closedSuperseded: 'Bilgi bankası değişince kapandı · {when}',
  // An opened task.
  sought: 'Aranan', where: 'Nerede', signals: 'Aranan işaretler', exclusions: 'Hariç tutulanlar',
  size: 'Büyüklük', language: 'Dil', segment: 'Kitle', note: 'Ajana not',
  paceStanding: 'Günde en çok {cap} aday.', paceOneOff: 'Günde en çok {cap} aday; {target} aday bulununca kapanır.',
  showAll: 'Tümünü göster ({n})', showLess: 'Daha az göster',
  standing: 'Bu görev Bilgi bankasından gelir: neyin, nerede aranacağını “Kimi arıyoruz” kartı belirler.',
  editKnowledge: 'Bilgi bankasında değiştir',
  newest: 'Son bulunanlar', noProspects: 'Bu görev henüz aday bulmadı.', poolLink: 'Bu görevin {n} adayını havuzda gör',
  claimHelp: 'İki saatliğine bu görevi sen yürütürsün: ajanlara görevin sende olduğu söylenir, o sürede başka görevlere yönelirler. Aday eklemeleri engellenmez.',
  claim: 'İki saatliğine ben bakıyorum', renew: 'İki saat daha uzat',
  heldOther: '{name} bu görevde (bitiş {until}); süre dolmadan başkası üstlenemez.',
  claimed: 'Görev iki saatliğine sende.', claimTaken: 'Görevi bu arada başkası üstlendi.',
  close: 'Görevi kapat', closeHelp: 'Kapanan görev için ajanlar yeni aday aramaz.', closeNote: 'Kapanış notu (isteğe bağlı)',
  closeDone: 'Tamamlandı say', closeCancel: 'İptal et', back: 'Vazgeç', closedToast: 'Görev kapatıldı.',
  closeNoteShown: 'Kapanış notu: {note}', autoClosed: 'Hedefe ulaşınca kendiliğinden kapandı.',
  // When nothing is happening.
  idleNoAgent: '{n} görev bugün aday bekliyor; bu işe bakabilecek bağlı bir ajan yok.',
  idleOverdue: '{n} görev bugün aday bekliyor; ajan en son {time} yoklama yaptı.',
  emptyTitle: 'Henüz araştırma görevi yok',
  emptyBody: 'Bilgi bankasındaki “Kimi arıyoruz” kartından ajan görevler açar. Kendin de tek seferlik bir görev açabilirsin.',
  noOpen: 'Açık görev yok.', noClosed: 'Kapanan görev yok.', moreClosed: 'Daha eskileri göster',
  // The composer.
  composer: 'Yeni araştırma görevi', soughtField: 'Ne aranacak?', soughtHint: 'kafe, pastane',
  whereField: 'Nerede?', whereHint: 'İzmir / Alsancak, Manisa', commaHelp: 'Virgülle ayır.',
  whereHelp: 'Şehir ya da şehir / ilçe; virgülle ayır.',
  paceBefore: 'Toplam', paceMiddle: 'aday bulununca kapanır; günde en çok', paceAfter: 'aday.',
  targetField: 'Bulunacak aday sayısı', capField: 'Günlük üst sınır',
  startFrom: 'Bir görevin tarifinden başla', startEmpty: 'Boş başla',
  more: 'Daha fazla ayrıntı', lineHelp: 'Her satıra bir tane.', segmentNone: 'Seçilmedi',
  sizeHint: 'ör. 1–3 şube', languageAny: 'Fark etmez', languageOther: 'Başka bir dil', languageCode: 'Dil kodu',
  languageCodeHint: 'ör. fr',
  submit: 'Görevi aç', created: 'Görev açıldı.',
  eSectorsCount: 'Ne aranacağına 1 ile 10 arasında madde yaz.', eItemLength: 'Bir madde çok uzun.',
  eAreasCount: 'Bir görevde 1 ile 20 arasında yer olabilir.', ePlaceLength: 'Bir şehir ya da ilçe adı en çok 80 karakter olabilir.',
  eListCount: 'En çok 10 madde yazılabilir.', eSize: 'Büyüklük en çok 200 karakter olabilir.',
  eLanguage: 'Dil kodu harflerden oluşmalı (ör. tr, en).', eNote: 'Not en çok 1000 karakter olabilir.',
  eSegment: 'Bu kitle Bilgi bankasında yok.', eRange: 'Sayılar 1 ile 500 arasında olmalı.',
};

const en: typeof tr = {
  navLabel: 'Prospect pool sections', navProspects: 'Prospects', navTasks: 'Research tasks',
  newTask: 'New task',
  listLabel: 'Research tasks', filterLabel: 'Tasks', open: 'Open', closed: 'Closed',
  oneOff: 'One-off', fromKnowledge: 'From the knowledge base', moreItems: '+{n}',
  cities: '{n} cities', districts: '{city} · {n} districts',
  foundWord: 'found', qualified: '{n} qualified',
  today: 'today {n}/{cap}', lastFound: 'last {when}', noneYet: 'none found yet',
  heldByAgent: '{name} is on it · until {until}', heldByYou: 'You are on it · until {until}',
  heldByMember: '{name} is on it · until {until}', waiting: 'Waiting for an agent to take it',
  doneToday: 'Done for today', pausedToday: 'No new prospects expected today',
  closedDone: 'Done · {when}', closedCanceled: 'Canceled · {when}',
  closedSuperseded: 'Closed when the knowledge base changed · {when}',
  sought: 'Looking for', where: 'Where', signals: 'Signals to look for', exclusions: 'Excluded',
  size: 'Size', language: 'Language', segment: 'Audience', note: 'Note to the agent',
  paceStanding: 'At most {cap} prospects a day.', paceOneOff: 'At most {cap} prospects a day; closes once {target} are found.',
  showAll: 'Show all ({n})', showLess: 'Show less',
  standing: 'This task comes from the knowledge base: the “Kimi arıyoruz” card says what to look for and where.',
  editKnowledge: 'Change it in the knowledge base',
  newest: 'Latest found', noProspects: 'This task has found no prospects yet.', poolLink: 'See this task’s {n} prospects in the pool',
  claimHelp: 'You run this task for two hours: agents are told it is yours and turn to other tasks meanwhile. Adding prospects is not blocked.',
  claim: 'I’ll take it for two hours', renew: 'Two more hours',
  heldOther: '{name} is on it (until {until}); nobody else can take it before then.',
  claimed: 'The task is yours for two hours.', claimTaken: 'Someone else took the task meanwhile.',
  close: 'Close task', closeHelp: 'Agents stop looking for a closed task.', closeNote: 'Closing note (optional)',
  closeDone: 'Mark done', closeCancel: 'Cancel it', back: 'Back', closedToast: 'Task closed.',
  closeNoteShown: 'Closing note: {note}', autoClosed: 'Closed by itself once its target was reached.',
  idleNoAgent: '{n} tasks wait for prospects today; no connected agent can work on them.',
  idleOverdue: '{n} tasks wait for prospects today; an agent last checked in {time}.',
  emptyTitle: 'No research tasks yet',
  emptyBody: 'The agent opens tasks from the “Kimi arıyoruz” card of the knowledge base. You can open a one-off task too.',
  noOpen: 'No open tasks.', noClosed: 'No closed tasks.', moreClosed: 'Show older ones',
  composer: 'New research task', soughtField: 'What to look for?', soughtHint: 'café, bakery',
  whereField: 'Where?', whereHint: 'İzmir / Alsancak, Manisa', commaHelp: 'Separate with commas.',
  whereHelp: 'A city or city / district; separate with commas.',
  paceBefore: 'Closes once', paceMiddle: 'prospects are found; at most', paceAfter: 'a day.',
  targetField: 'Prospects to find', capField: 'Daily cap',
  startFrom: 'Start from a task’s brief', startEmpty: 'Start empty',
  more: 'More details', lineHelp: 'One per line.', segmentNone: 'None chosen',
  sizeHint: 'e.g. 1–3 branches', languageAny: 'Any', languageOther: 'Another language', languageCode: 'Language code',
  languageCodeHint: 'e.g. fr',
  submit: 'Open task', created: 'Task opened.',
  eSectorsCount: 'Write 1 to 10 things to look for.', eItemLength: 'An item is too long.',
  eAreasCount: 'A task takes 1 to 20 places.', ePlaceLength: 'A city or district name is at most 80 characters.',
  eListCount: 'At most 10 items.', eSize: 'Size is at most 200 characters.',
  eLanguage: 'A language code is letters only (e.g. tr, en).', eNote: 'The note is at most 1000 characters.',
  eSegment: 'The knowledge base has no such audience.', eRange: 'Numbers are 1 to 500.',
};

export type TaskCopyKey = keyof typeof tr;
export type TaskCopy = ((key: TaskCopyKey, vars?: Record<string, string | number>) => string) & { language: string };

export function useTaskCopy(): TaskCopy {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const table = language.startsWith('tr') ? tr : en;
  const copy = ((key: TaskCopyKey, vars: Record<string, string | number> = {}) =>
    table[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))) as TaskCopy;
  copy.language = language;
  return copy;
}

/** Both tables, for the parity test. */
export const TASK_COPY = { tr, en };
