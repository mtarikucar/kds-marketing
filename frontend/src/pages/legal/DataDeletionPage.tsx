import { LegalLayout } from './legalShared';
import dataDeletionContent from './content/dataDeletion';

/**
 * Public data-deletion instructions. Meta accepts this URL as an alternative to
 * the signed_request deletion callback, and the TikTok / Pinterest / LinkedIn
 * reviews each expect an equivalent page. Reuses the legal reader layout so it
 * sits beside /privacy and /terms rather than looking like a stray page.
 */
export default function DataDeletionPage() {
  return <LegalLayout content={dataDeletionContent} />;
}
