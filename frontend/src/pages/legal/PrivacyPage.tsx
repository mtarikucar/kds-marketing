import { LegalLayout } from './legalShared';
import privacyContent from './content/privacy';

export default function PrivacyPage() {
  return <LegalLayout content={privacyContent} />;
}
