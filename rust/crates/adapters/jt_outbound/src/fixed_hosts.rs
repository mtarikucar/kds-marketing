//! The fixed tier's contents (spec §4.3, "sabit katman"): the provider hosts each connector may
//! reach, and the one provider endpoint reached over plain http.
//!
//! **The plain-http exception is a provider limitation.** NetGSM's Netsantral (the cloud PBX)
//! serves its click-to-call endpoint only as plain `http` on port 9111 of
//! `crmsntrl.netgsm.com.tr`; there is no `https` endpoint to use instead. So that one host and
//! port, under the `netgsm` connector's scope alone, is reached over plain http
//! ([`PLAIN_HTTP_EXCEPTIONS`], [`allow_plain_http`]). Every other host, the other NetGSM hosts
//! included, is `https` only. The exception widens the scheme, not the allowlist: the host must
//! still be on the connector's fixed tier, and the DNS guard still checks what it resolves to.

use crate::allowlist::AllowedHost;
use crate::client::EgressScope;

const fn host(connector: &'static str, host: &'static str) -> AllowedHost {
    AllowedHost { connector, host }
}

/// The fixed tier: the provider hosts each connector may reach, and nothing else. A connector
/// scope reaches only the entries carrying its own name; an entry with a port only that port.
///
/// - `meta`: the Graph API (`graph.facebook.com`), the Instagram Graph API and Instagram login
///   (`graph.instagram.com`, `api.instagram.com`) and the resumable media upload
///   (`rupload.facebook.com`);
/// - `netgsm`: SMS and the account API (`api.netgsm.com.tr`), WhatsApp
///   (`whatsappapi.netgsm.com.tr`), voice files (`sesdosya.netgsm.com.tr`) and the Netsantral
///   click-to-call endpoint (`crmsntrl.netgsm.com.tr:9111`, plain http: see the module docs);
/// - `x`: the X API under both its names (`api.twitter.com`, `api.x.com`).
pub const FIXED_HOSTS: &[AllowedHost] = &[
    host("meta", "graph.facebook.com"),
    host("meta", "graph.instagram.com"),
    host("meta", "api.instagram.com"),
    host("meta", "rupload.facebook.com"),
    host("netgsm", "api.netgsm.com.tr"),
    host("netgsm", "whatsappapi.netgsm.com.tr"),
    host("netgsm", "sesdosya.netgsm.com.tr"),
    host("netgsm", "crmsntrl.netgsm.com.tr:9111"),
    host("x", "api.twitter.com"),
    host("x", "api.x.com"),
];

/// The endpoints reached over plain `http`, as `(connector, host, port)`: only NetGSM's
/// Netsantral, a provider limitation (see the module docs).
pub const PLAIN_HTTP_EXCEPTIONS: &[(&str, &str, u16)] =
    &[("netgsm", "crmsntrl.netgsm.com.tr", 9111)];

/// Whether a plain-`http` request to `host` (compared ignoring ASCII case) on `port` may be sent
/// under `scope`: only for an entry of [`PLAIN_HTTP_EXCEPTIONS`], under that entry's connector
/// scope. Never for a tenant scope. The allowlist still has to let the host in for the scope.
pub fn allow_plain_http(scope: &EgressScope, host: &str, port: u16) -> bool {
    let EgressScope::Connector(connector) = scope else {
        return false;
    };
    PLAIN_HTTP_EXCEPTIONS
        .iter()
        .any(|(c, h, p)| c == connector && host.eq_ignore_ascii_case(h) && *p == port)
}

#[cfg(test)]
mod tests {
    use jt_tenancy::WorkspaceId;

    use super::*;
    use crate::{AllowedHost, Egress, EgressScope, Url, validate_public_host};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn fixed_hosts_are_exactly_the_documented_set() {
        let table: Vec<(&str, &str)> = FIXED_HOSTS.iter().map(|h| (h.connector, h.host)).collect();
        assert_eq!(
            table,
            [
                ("meta", "graph.facebook.com"),
                ("meta", "graph.instagram.com"),
                ("meta", "api.instagram.com"),
                ("meta", "rupload.facebook.com"),
                ("netgsm", "api.netgsm.com.tr"),
                ("netgsm", "whatsappapi.netgsm.com.tr"),
                ("netgsm", "sesdosya.netgsm.com.tr"),
                ("netgsm", "crmsntrl.netgsm.com.tr:9111"),
                ("x", "api.twitter.com"),
                ("x", "api.x.com"),
            ]
        );
        // Every provider host is on the public internet, and the table builds a client.
        for entry in FIXED_HOSTS {
            assert_eq!(validate_public_host(entry.host), Ok(()), "{entry:?}");
        }
        Egress::new(FIXED_HOSTS);
    }

    #[test]
    fn each_connector_reaches_only_its_own_hosts() {
        let egress = Egress::new(FIXED_HOSTS);
        for (connector, allowed) in [
            ("meta", "https://graph.facebook.com/v21.0/me"),
            ("meta", "https://graph.instagram.com/me"),
            ("meta", "https://api.instagram.com/oauth/access_token"),
            ("meta", "https://rupload.facebook.com/ig-api-upload/1"),
            ("netgsm", "https://api.netgsm.com.tr/sms/send/get"),
            ("netgsm", "https://whatsappapi.netgsm.com.tr/"),
            ("netgsm", "https://sesdosya.netgsm.com.tr/"),
            ("netgsm", "https://crmsntrl.netgsm.com.tr:9111/"),
            ("x", "https://api.twitter.com/2/tweets"),
            ("x", "https://api.x.com/2/tweets"),
        ] {
            let target = url(allowed);
            assert!(
                egress.permits(EgressScope::Connector(connector), &target),
                "{connector}: {allowed}"
            );
            for other in ["meta", "netgsm", "x", "tiktok"] {
                if other != connector {
                    assert!(
                        !egress.permits(EgressScope::Connector(other), &target),
                        "{other} must not reach {allowed}"
                    );
                }
            }
            assert!(
                !egress.permits(EgressScope::Tenant(WorkspaceId::new_v7()), &target),
                "no tenant reaches {allowed}"
            );
        }
        for refused in [
            // A port the entry does not name, a sub-domain, a look-alike.
            "https://crmsntrl.netgsm.com.tr/",
            "https://evil.graph.facebook.com/",
            "https://graph.facebook.com.evil.example/",
            // Plain http to an https-only provider host.
            "http://graph.facebook.com/v21.0/me",
            "http://api.x.com/2/tweets",
        ] {
            for connector in ["meta", "netgsm", "x"] {
                assert!(
                    !egress.permits(EgressScope::Connector(connector), &url(refused)),
                    "{connector}: {refused}"
                );
            }
        }
    }

    #[test]
    fn plain_http_only_for_netsantral() {
        assert_eq!(
            PLAIN_HTTP_EXCEPTIONS,
            [("netgsm", "crmsntrl.netgsm.com.tr", 9111)]
        );
        let netgsm = EgressScope::Connector("netgsm");
        assert!(allow_plain_http(&netgsm, "crmsntrl.netgsm.com.tr", 9111));
        assert!(allow_plain_http(&netgsm, "CRMSNTRL.Netgsm.com.tr", 9111));
        for (host, port) in [
            ("crmsntrl.netgsm.com.tr", 80),
            ("crmsntrl.netgsm.com.tr", 443),
            ("crmsntrl.netgsm.com.tr", 9112),
            ("api.netgsm.com.tr", 9111),
            ("api.netgsm.com.tr", 80),
            ("whatsappapi.netgsm.com.tr", 80),
            ("sesdosya.netgsm.com.tr", 9111),
            ("crmsntrl.netgsm.com.tr.evil.example", 9111),
            ("evil.crmsntrl.netgsm.com.tr", 9111),
            ("127.0.0.1", 9111),
        ] {
            assert!(!allow_plain_http(&netgsm, host, port), "{host}:{port}");
        }

        let egress = Egress::new(FIXED_HOSTS);
        assert!(egress.permits(
            netgsm,
            &url("http://crmsntrl.netgsm.com.tr:9111/linkup?username=x&customer_num=1")
        ));
        for refused in [
            "http://crmsntrl.netgsm.com.tr/",
            "http://crmsntrl.netgsm.com.tr:80/",
            "http://crmsntrl.netgsm.com.tr:9112/",
            "http://api.netgsm.com.tr/sms/send/get",
            "http://api.netgsm.com.tr:9111/",
            "http://whatsappapi.netgsm.com.tr/",
            "http://sesdosya.netgsm.com.tr/",
            "ftp://crmsntrl.netgsm.com.tr:9111/",
        ] {
            assert!(!egress.permits(netgsm, &url(refused)), "{refused}");
        }
    }

    #[tokio::test]
    async fn netsantral_userinfo_trick_is_refused() {
        // The text before `@` is userinfo: the host is `evil.example`, whatever the URL starts
        // with, so neither the exception nor the fixed tier lets it through.
        let egress = Egress::new(FIXED_HOSTS);
        let netgsm = EgressScope::Connector("netgsm");
        for trick in [
            "http://crmsntrl.netgsm.com.tr:9111@evil.example/",
            "http://crmsntrl.netgsm.com.tr:9111@evil.example:9111/",
            "https://crmsntrl.netgsm.com.tr:9111@evil.example:9111/",
            "http://user:pw@crmsntrl.netgsm.com.tr:9111@evil.example:9111/",
        ] {
            let target = url(trick);
            assert_eq!(target.host_str(), Some("evil.example"), "{trick}");
            assert!(!egress.permits(netgsm, &target), "{trick}");
            match egress
                .send(netgsm, crate::Request::new(crate::Method::GET, target))
                .await
            {
                Err(crate::EgressError::HostNotAllowed { host }) => {
                    assert_eq!(host, "evil.example", "{trick}")
                }
                other => panic!("{trick} must be refused, got {other:?}"),
            }
        }
    }

    #[test]
    fn plain_http_is_refused_for_netsantral_under_other_scopes() {
        let ws = WorkspaceId::new_v7();
        for scope in [
            EgressScope::Connector("meta"),
            EgressScope::Connector("x"),
            EgressScope::Connector("netgsm2"),
            EgressScope::Connector("NETGSM"),
            EgressScope::Tenant(ws),
        ] {
            assert!(
                !allow_plain_http(&scope, "crmsntrl.netgsm.com.tr", 9111),
                "{scope:?}"
            );
        }

        // Even when the scope's own list holds the host, only https reaches it.
        let egress = Egress::new(&[AllowedHost {
            connector: "meta",
            host: "crmsntrl.netgsm.com.tr:9111",
        }]);
        egress.allow_tenant_host(ws, "crmsntrl.netgsm.com.tr:9111");
        for scope in [EgressScope::Connector("meta"), EgressScope::Tenant(ws)] {
            assert!(
                !egress.permits(scope, &url("http://crmsntrl.netgsm.com.tr:9111/linkup")),
                "{scope:?}"
            );
            assert!(
                egress.permits(scope, &url("https://crmsntrl.netgsm.com.tr:9111/linkup")),
                "{scope:?}"
            );
        }
    }
}
