import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { useGatedTabs } from '../../../features/marketing/hooks/useGatedTabs';
import { RouteFallback } from '../../../components/RouteFallback';

// Lazy so a tab's code only loads when it is opened. Each of these was its own
// route, and none should be paid for by someone who wanted another.
const ProductsPage = lazy(() => import('./ProductsPage'));
const OrderFormsPage = lazy(() => import('../orderForms/OrderFormsPage'));
const SubscriptionsPage = lazy(() => import('../subscriptions/SubscriptionsPage'));
const InvoicesPage = lazy(() => import('../invoices'));

const TAB_GATES = [
  { value: 'products' },
  { value: 'order-forms' },
  { value: 'subscriptions' },
  { value: 'invoices', feature: 'invoicing' as const },
] as const;
type Tab = (typeof TAB_GATES)[number]['value'];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Everything about selling, in the order a sale happens.
 *
 * A product is what you sell, an order form is how somebody buys it, a
 * subscription is what recurs and an invoice is what gets paid. These were
 * four entries in a list, and the second of them is the only one that MAKES
 * the other three — you cannot author an order form without a product, and
 * it produces the invoice. One page follows the money.
 *
 * Every absorbed route still resolves — App.tsx redirects each to its tab, and
 * the command palette offers each half by its own name. The LIST got shorter;
 * nothing became unreachable.
 */
export default function SellingPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  // Gated, not merely validated: a half this workspace has not bought must
  // not be openable by typing its name into the URL either.
  const { allowed, active } = useGatedTabs(TAB_GATES, raw);
  const tab = active as Tab;

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('selling.title', { defaultValue: 'Selling' })}
        description={t('selling.subtitle', { defaultValue: 'What you sell, how people buy it, what recurs, and what gets invoiced.' })}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {allowed.includes('products') && <TabsTrigger value="products">{t('selling.tab.products', { defaultValue: 'Products' })}</TabsTrigger>}
          {allowed.includes('order-forms') && <TabsTrigger value="order-forms">{t('selling.tab.order-forms', { defaultValue: 'Order forms' })}</TabsTrigger>}
          {allowed.includes('subscriptions') && <TabsTrigger value="subscriptions">{t('selling.tab.subscriptions', { defaultValue: 'Subscriptions' })}</TabsTrigger>}
          {allowed.includes('invoices') && <TabsTrigger value="invoices">{t('selling.tab.invoices', { defaultValue: 'Invoices' })}</TabsTrigger>}
        </TabsList>

        {allowed.includes('products') && <TabsContent value="products" className="pt-5">
          <Lazy><ProductsPage embedded param="sub" /></Lazy>
        </TabsContent>}
        {allowed.includes('order-forms') && <TabsContent value="order-forms" className="pt-5">
          <Lazy><OrderFormsPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('subscriptions') && <TabsContent value="subscriptions" className="pt-5">
          <Lazy><SubscriptionsPage embedded /></Lazy>
        </TabsContent>}
        {allowed.includes('invoices') && <TabsContent value="invoices" className="pt-5">
          <Lazy><InvoicesPage embedded /></Lazy>
        </TabsContent>}
      </Tabs>
    </div>
  );
}
