//! The provider adapters the server runs: Meta (`jt_meta`), NetGSM (`jt_netgsm`) and X (`jt_x`),
//! each sending to its production hosts through the one egress client the server builds, behind
//! the use cases' [`ConnectorRegistry`] port.
//!
//! Each adapter is offered for exactly the operations it implements:
//!
//! | provider | connector | OAuth | SMS, calls, consent, delivery reports | publishing, counters | messaging, ad budgets, lead-gen |
//! |---|---|---|---|---|---|
//! | Meta | ✓ | ✓ | — | ✓ | ✓ |
//! | NetGSM | ✓ | — (credentials by hand) | ✓ | — | — |
//! | X | ✓ | ✓ | — | ✓ | — |
//!
//! (the same matrix `jt_testkit::fakes::ScriptedRegistry` offers, so the use cases' tests never
//! count on more than production has). The OAuth flows need the platform's provider apps
//! ([`PlatformAppConfig`], from the environment: `crate::config::EnvPlatformApps`), read at call
//! time; without one they answer `CONFLICT` "provider app not configured".

use std::sync::Arc;

use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, InsightsReader,
    LeadGenFetcher, MailSender, MailboxPoller, MessagingSender, OAuthProvider, PlatformAppConfig,
    Publisher, SmsSender, Telephony,
};
use jt_connector::Provider;
use jt_meta::{MetaBases, MetaConnector};
use jt_netgsm::{NetgsmBases, NetgsmConnector};
use jt_outbound::Egress;
use jt_x::{XBases, XConnector};

/// The registry of the three production adapters over `egress` (the client whose tenant tier
/// the use cases' host registry fills), reading the platform's provider apps from `apps` at call
/// time.
pub fn registry(
    egress: Arc<Egress>,
    apps: Arc<dyn PlatformAppConfig>,
) -> Arc<dyn ConnectorRegistry> {
    Arc::new(ProviderRegistry {
        meta: Arc::new(MetaConnector::new(
            Arc::clone(&egress),
            MetaBases::production(),
            Arc::clone(&apps),
        )),
        netgsm: Arc::new(NetgsmConnector::new(
            Arc::clone(&egress),
            NetgsmBases::production(),
        )),
        x: Arc::new(XConnector::new(egress, XBases::production(), apps)),
    })
}

/// The three adapters, each shared by every operation it offers.
struct ProviderRegistry {
    meta: Arc<MetaConnector>,
    netgsm: Arc<NetgsmConnector>,
    x: Arc<XConnector>,
}

impl ConnectorRegistry for ProviderRegistry {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        Some(match provider {
            Provider::Meta => self.meta.clone(),
            Provider::Netgsm => self.netgsm.clone(),
            Provider::X => self.x.clone(),
            // Mail needs a workspace-bound registry lookup. Do not guess the tenant from
            // credentials or permit tenant hosts through a global provider instance.
            Provider::Mail => return None,
        })
    }

    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>> {
        match provider {
            Provider::Meta => Some(self.meta.clone()),
            Provider::X => Some(self.x.clone()),
            Provider::Netgsm | Provider::Mail => None,
        }
    }

    fn mail_sender(&self, _provider: Provider) -> Option<Arc<dyn MailSender>> {
        None
    }

    fn mailbox_poller(&self, _provider: Provider) -> Option<Arc<dyn MailboxPoller>> {
        None
    }

    fn sms(&self, provider: Provider) -> Option<Arc<dyn SmsSender>> {
        (provider == Provider::Netgsm).then(|| self.netgsm.clone() as Arc<dyn SmsSender>)
    }

    fn publisher(&self, provider: Provider) -> Option<Arc<dyn Publisher>> {
        match provider {
            Provider::Meta => Some(self.meta.clone()),
            Provider::X => Some(self.x.clone()),
            Provider::Netgsm | Provider::Mail => None,
        }
    }

    fn insights(&self, provider: Provider) -> Option<Arc<dyn InsightsReader>> {
        match provider {
            Provider::Meta => Some(self.meta.clone()),
            Provider::X => Some(self.x.clone()),
            Provider::Netgsm | Provider::Mail => None,
        }
    }

    fn messaging(&self, provider: Provider) -> Option<Arc<dyn MessagingSender>> {
        (provider == Provider::Meta).then(|| self.meta.clone() as Arc<dyn MessagingSender>)
    }

    fn ads(&self, provider: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        (provider == Provider::Meta).then(|| self.meta.clone() as Arc<dyn AdBudgetWriter>)
    }

    fn leadgen(&self, provider: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        (provider == Provider::Meta).then(|| self.meta.clone() as Arc<dyn LeadGenFetcher>)
    }

    fn telephony(&self, provider: Provider) -> Option<Arc<dyn Telephony>> {
        (provider == Provider::Netgsm).then(|| self.netgsm.clone() as Arc<dyn Telephony>)
    }

    fn consent(&self, provider: Provider) -> Option<Arc<dyn ConsentSync>> {
        (provider == Provider::Netgsm).then(|| self.netgsm.clone() as Arc<dyn ConsentSync>)
    }

    fn delivery_reports(&self, provider: Provider) -> Option<Arc<dyn DeliveryReports>> {
        (provider == Provider::Netgsm).then(|| self.netgsm.clone() as Arc<dyn DeliveryReports>)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use jt_app::std_impls::NoPlatformApps;
    use jt_outbound::FIXED_HOSTS;
    use jt_testkit::fakes::{ScriptedConnector, ScriptedOAuth, ScriptedRegistry};

    use super::*;

    /// The operations `registry` offers for `provider`, by name.
    fn offered(registry: &dyn ConnectorRegistry, provider: Provider) -> BTreeSet<&'static str> {
        [
            ("connector", registry.connector(provider).is_some()),
            ("oauth", registry.oauth(provider).is_some()),
            ("sms", registry.sms(provider).is_some()),
            ("mail_sender", registry.mail_sender(provider).is_some()),
            (
                "mailbox_poller",
                registry.mailbox_poller(provider).is_some(),
            ),
            ("publisher", registry.publisher(provider).is_some()),
            ("insights", registry.insights(provider).is_some()),
            ("messaging", registry.messaging(provider).is_some()),
            ("ads", registry.ads(provider).is_some()),
            ("leadgen", registry.leadgen(provider).is_some()),
            ("telephony", registry.telephony(provider).is_some()),
            ("consent", registry.consent(provider).is_some()),
            (
                "delivery_reports",
                registry.delivery_reports(provider).is_some(),
            ),
        ]
        .into_iter()
        .filter_map(|(name, some)| some.then_some(name))
        .collect()
    }

    fn production() -> Arc<dyn ConnectorRegistry> {
        let egress = Arc::new(Egress::new(FIXED_HOSTS));
        registry(egress, Arc::new(NoPlatformApps))
    }

    #[test]
    fn each_adapter_is_offered_for_what_it_implements() {
        let registry = production();
        let expected = [
            (
                Provider::Meta,
                vec![
                    "connector",
                    "oauth",
                    "publisher",
                    "insights",
                    "messaging",
                    "ads",
                    "leadgen",
                ],
            ),
            (
                Provider::Netgsm,
                vec![
                    "connector",
                    "sms",
                    "telephony",
                    "consent",
                    "delivery_reports",
                ],
            ),
            (
                Provider::X,
                vec!["connector", "oauth", "publisher", "insights"],
            ),
            (Provider::Mail, vec![]),
        ];
        assert_eq!(expected.len(), Provider::all().len());
        assert_eq!(
            expected
                .iter()
                .map(|(provider, _)| *provider)
                .collect::<BTreeSet<_>>(),
            Provider::all().iter().copied().collect()
        );
        for (provider, operations) in expected {
            let operations: BTreeSet<&str> = operations.into_iter().collect();
            assert_eq!(
                offered(registry.as_ref(), provider),
                operations,
                "{}",
                provider.key()
            );
        }
    }

    #[test]
    fn the_scripted_registry_offers_no_more_than_production() {
        // Register exactly the adapters currently installed by the production factory; mail
        // remains absent until the registry can bind an adapter to a request's workspace.
        let mut scripted = ScriptedRegistry::new();
        for provider in [Provider::Meta, Provider::Netgsm, Provider::X] {
            scripted = scripted.with_connector(Arc::new(ScriptedConnector::new(provider)));
            if provider != Provider::Netgsm {
                scripted = scripted.with_oauth(Arc::new(ScriptedOAuth::new(provider)));
            }
        }
        let registry = production();
        for provider in Provider::all() {
            assert_eq!(
                offered(&scripted, *provider),
                offered(registry.as_ref(), *provider),
                "{}",
                provider.key()
            );
        }
    }

    #[test]
    fn each_adapter_names_its_provider_and_only_its_fixed_hosts() {
        let registry = production();
        for provider in Provider::all() {
            if *provider == Provider::Mail {
                assert!(registry.connector(*provider).is_none());
                assert!(FIXED_HOSTS.iter().all(|h| h.connector != provider.key()));
                continue;
            }
            let connector = registry.connector(*provider).unwrap();
            assert_eq!(connector.provider(), *provider);
            let fixed: BTreeSet<&str> = FIXED_HOSTS
                .iter()
                .filter(|h| h.connector == provider.key())
                .map(|h| h.host)
                .collect();
            assert!(!connector.hosts().is_empty(), "{}", provider.key());
            for host in connector.hosts() {
                assert!(fixed.contains(host), "{} reaches {host}", provider.key());
            }
        }
    }
}
