import { LegalLayout } from './legalShared';
import termsContent from './content/terms';

export default function TermsPage() {
  return <LegalLayout content={termsContent} />;
}
