import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, SearchX, AlertTriangle, HelpCircle } from 'lucide-react';
import { SHELL } from '../landing/landingShared';
import LandingNav from '../landing/LandingNav';
import LandingFooter from '../landing/LandingFooter';
import { LEGAL } from './legalConfig';
import { fetchDeletionStatus, type DeletionStatus } from '../../features/marketing/api/dataDeletion.service';

/**
 * The page the `url` in our answer to Meta's data-deletion callback points at.
 *
 * Meta's contract is that a person can open this URL and see what happened to
 * their request. Every state it can be in is named out loud, including the two
 * uncomfortable ones — "we found no data of yours" and "this could not be
 * completed" — because a page that renders blank, or that says "deleted" for
 * data we never found, is exactly the dishonesty the callback exists to avoid.
 *
 * Public: no session, no auth. The confirmation code in the query string is the
 * only input, and it addresses a row that holds no personal data (the subject
 * is stored as a SHA-256 digest server-side and is never served here).
 */

type View =
  | { kind: 'loading' }
  | { kind: 'no-code' }
  | { kind: 'not-found' }
  | { kind: 'error' }
  | { kind: 'found'; row: DeletionStatus };

const tone = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  wait: 'border-amber-200 bg-amber-50 text-amber-900',
  none: 'border-slate-200 bg-slate-50 text-slate-800',
  bad: 'border-rose-200 bg-rose-50 text-rose-900',
} as const;

export default function DataDeletionStatusPage() {
  const { i18n } = useTranslation('marketing');
  const tr = (i18n.language || 'tr').slice(0, 2) === 'tr';
  const [params] = useSearchParams();
  const code = (params.get('code') ?? '').trim();
  const [view, setView] = useState<View>(() => (code ? { kind: 'loading' } : { kind: 'no-code' }));

  useEffect(() => {
    document.title = `Jeeta Growth — ${tr ? 'Veri Silme Talebi Durumu' : 'Data Deletion Request Status'}`;
  }, [tr]);

  useEffect(() => {
    if (!code) {
      setView({ kind: 'no-code' });
      return;
    }
    let live = true;
    setView({ kind: 'loading' });
    fetchDeletionStatus(code)
      .then((row) => {
        if (!live) return;
        // null is an ANSWER ("no such code"), not a failure — they render
        // differently on purpose.
        setView(row ? { kind: 'found', row } : { kind: 'not-found' });
      })
      .catch(() => {
        if (live) setView({ kind: 'error' });
      });
    return () => {
      live = false;
    };
  }, [code]);

  const body = (() => {
    switch (view.kind) {
      case 'loading':
        return {
          icon: <Clock className="h-6 w-6" />,
          cls: tone.none,
          title: tr ? 'Kontrol ediliyor…' : 'Checking…',
          text: tr ? 'Talebinizin durumu alınıyor.' : 'Looking up the state of your request.',
        };
      case 'no-code':
        return {
          icon: <HelpCircle className="h-6 w-6" />,
          cls: tone.none,
          title: tr ? 'Onay kodu yok' : 'No confirmation code',
          text: tr
            ? 'Bu bağlantıda bir onay kodu yok. Platformun size verdiği bağlantıyı kullanın veya kodu bize e-postayla iletin.'
            : 'This link carries no confirmation code. Use the link the platform gave you, or send us the code by email.',
        };
      case 'not-found':
        return {
          icon: <SearchX className="h-6 w-6" />,
          cls: tone.none,
          title: tr ? 'Bu koda ait kayıt yok' : 'No record for this code',
          text: tr
            ? 'Bu onay koduyla eşleşen bir silme talebi bulamadık. Kodu kontrol edin; doğruysa aşağıdaki adresten bize yazın.'
            : 'We found no record of a deletion request with this confirmation code. Check the code; if it is correct, write to us at the address below.',
        };
      case 'error':
        return {
          icon: <AlertTriangle className="h-6 w-6" />,
          cls: tone.bad,
          title: tr ? 'Durum kontrol edilemedi' : 'Status could not be checked',
          text: tr
            ? 'Şu anda talebinizin durumuna ulaşamıyoruz. Bu, talebinizin bulunamadığı anlamına gelmez — lütfen birazdan tekrar deneyin.'
            : 'We could not reach the status of your request right now. This does not mean nothing was found — please try again shortly.',
        };
      case 'found':
        switch (view.row.status) {
          case 'COMPLETED':
            return {
              icon: <CheckCircle2 className="h-6 w-6" />,
              cls: tone.ok,
              title: tr ? 'Verileriniz silindi' : 'Your data has been deleted',
              text: tr
                ? 'Talebiniz yerine getirildi. Size ait yazışmalar, kanal kimlikleri ve profil bilgileri silindi veya anonimleştirildi. Yasal olarak saklanması zorunlu mali kayıtlar, artık sizi tanımlamayan anonim bir kayda bağlıdır.'
                : 'Your request has been fulfilled. Your conversations, channel identities and profile details were deleted or anonymized. Financial records we are legally required to keep now reference an anonymized record that no longer identifies you.',
            };
          case 'UNMATCHED':
            return {
              icon: <SearchX className="h-6 w-6" />,
              cls: tone.none,
              title: tr ? 'Size ait veri bulunamadı' : 'No personal data of yours was found',
              text: tr
                ? 'Talebinizi aldık ve kaydettik, ancak platformun bize ilettiği kimlikle eşleşen hiçbir veri bulamadık — bu yüzden "silindi" demiyoruz. Bunun olağan bir sebebi var: platformlar uygulamaya özgü bir kimlik gönderir ve bu, sizinle mesajlaştığımız kimlikten farklı olabilir. Kayıtlarımızda başka bir bilgiyle aranmamızı isterseniz aşağıdaki adresten bize yazın.'
                : 'We received and recorded your request, but found no personal data matching the identifier the platform sent us — so we are not telling you anything was deleted. There is an ordinary reason for this: platforms send an app-scoped identifier, which can differ from the one under which we messaged you. Write to us at the address below and we can look for you by another detail.',
            };
          case 'FAILED':
            return {
              icon: <AlertTriangle className="h-6 w-6" />,
              cls: tone.bad,
              title: tr ? 'Talep tamamlanamadı' : 'Your request could not be completed',
              text: tr
                ? 'Talebinizi aldık, ancak silme işlemi otomatik olarak tamamlanamadı ve bir ekip üyesinin bakması gerekiyor. Süreci hızlandırmak için aşağıdaki adresten onay kodunuzla bize yazabilirsiniz.'
                : 'We received your request, but the deletion could not be completed automatically and needs a person to look at it. You can write to us with your confirmation code at the address below to speed that up.',
            };
          default:
            return {
              icon: <Clock className="h-6 w-6" />,
              cls: tone.wait,
              title: tr ? 'Talebiniz alındı' : 'Your request has been received',
              text: tr
                ? 'Talebiniz kaydedildi ve işleniyor. Bu sayfayı onay kodunuzla tekrar ziyaret ederek durumu kontrol edebilirsiniz.'
                : 'Your request is recorded and is being processed. Revisit this page with your confirmation code to check the state.',
            };
        }
    }
  })();

  const fmt = (v: string | null | undefined) =>
    v ? new Date(v).toLocaleString(tr ? 'tr-TR' : 'en-GB') : '—';

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900 antialiased">
      <LandingNav solid showSectionLinks={false} />
      <main id="main" tabIndex={-1} className="outline-none">
        <header className="border-b border-slate-200 bg-slate-50 pb-10 pt-28 sm:pt-32">
          <div className={SHELL}>
            <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              {tr ? 'Veri Silme Talebi Durumu' : 'Data Deletion Request Status'}
            </h1>
            <p className="mt-3 max-w-2xl text-lg text-slate-500">
              {tr
                ? 'Onay kodunuzla talebinizin hangi aşamada olduğunu görün.'
                : 'Check where your request stands, using your confirmation code.'}
            </p>
          </div>
        </header>

        <div className={`${SHELL} py-12 sm:py-16`}>
          <div className="max-w-3xl">
            <div className={`flex gap-4 rounded-2xl border p-6 ${body.cls}`}>
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {body.icon}
              </span>
              <div>
                <h2 className="font-display text-xl font-semibold">{body.title}</h2>
                <p className="mt-2 text-[15px] leading-relaxed">{body.text}</p>
              </div>
            </div>

            {view.kind === 'found' && (
              <dl className="mt-6 space-y-1.5 rounded-2xl border border-slate-200 bg-white p-6 text-[14px] leading-relaxed text-slate-600">
                <div>
                  <dt className="inline font-medium text-slate-500">
                    {tr ? 'Onay kodu' : 'Confirmation code'}:{' '}
                  </dt>
                  <dd className="inline font-mono">{view.row.confirmationCode}</dd>
                </div>
                <div>
                  <dt className="inline font-medium text-slate-500">
                    {tr ? 'Alındığı tarih' : 'Received'}:{' '}
                  </dt>
                  <dd className="inline">{fmt(view.row.receivedAt)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium text-slate-500">
                    {tr ? 'Tamamlandığı tarih' : 'Completed'}:{' '}
                  </dt>
                  <dd className="inline">{fmt(view.row.completedAt)}</dd>
                </div>
              </dl>
            )}

            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-6">
              <p className="text-[15px] text-slate-600">
                {tr ? 'Sorularınız için bize ulaşın:' : 'For questions, contact us:'}
              </p>
              <a
                href={`mailto:${LEGAL.email}`}
                className="mt-2 inline-block font-semibold text-primary-700 hover:text-primary-600"
              >
                {LEGAL.email}
              </a>
              <p className="mt-4 text-[15px] text-slate-600">
                <Link to="/data-deletion" className="font-semibold text-primary-700 hover:text-primary-600">
                  {tr
                    ? 'Veri silme talebi nasıl iletilir?'
                    : 'How to make a data deletion request'}
                </Link>
              </p>
            </div>
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
