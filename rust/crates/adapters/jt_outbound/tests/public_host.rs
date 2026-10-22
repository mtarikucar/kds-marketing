//! The public-host guard of the tenant tier: a workspace may let its connectors reach only hosts
//! on the public internet, never this machine or a private network.

use jt_outbound::{HostError, validate_public_host};

#[test]
fn private_loopback_linklocal_cgnat_and_special_names_are_rejected() {
    for host in [
        // IPv4 literals: loopback, private, link-local, CGNAT, multicast, unspecified,
        // broadcast and the other special-purpose blocks.
        "127.0.0.1",
        "127.255.255.254",
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.10",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.255",
        "224.0.0.1",
        "239.255.255.250",
        "0.0.0.0",
        "0.1.2.3",
        "255.255.255.255",
        "240.0.0.1",
        "192.0.0.8",
        "192.0.2.1",
        "198.18.0.1",
        "198.51.100.7",
        "203.0.113.9",
        // The same, written the other ways a URL parser accepts IPv4.
        "127.1",
        "0x7f000001",
        "2130706433",
        "127.0.0.1.",
        // With a port.
        "127.0.0.1:8080",
        "10.0.0.1:443",
        // IPv6 literals: loopback, unspecified, unique local, link-local, site-local,
        // multicast, documentation, discard, IPv4-compatible, local NAT64.
        "[::1]",
        "[::]",
        "[fc00::1]",
        "[fd12:3456:789a::1]",
        "[fe80::1]",
        "[fec0::1]",
        "[ff02::1]",
        "[2001:db8::1]",
        "[100::1]",
        "[::7f00:1]",
        "[64:ff9b:1::1]",
        "[::1]:8443",
        // Names: this machine, single labels, private and special-purpose suffixes.
        "localhost",
        "LOCALHOST",
        "localhost.",
        "api.localhost",
        "localhost:8080",
        "intranet",
        "router.",
        "printer.local",
        "db.internal",
        "nas.lan",
        "box.home",
        "1.0.0.127.in-addr.arpa",
        "router.home.arpa",
        "localhost.localdomain",
    ] {
        assert!(
            validate_public_host(host).is_err(),
            "{host:?} must be refused"
        );
    }
}

#[test]
fn ipv4_mapped_ipv6_private_is_rejected() {
    for host in [
        "[::ffff:127.0.0.1]",
        "[::ffff:10.0.0.1]",
        "[::ffff:192.168.0.1]",
        "[::ffff:169.254.169.254]",
        "[::ffff:100.64.0.1]",
        "[::ffff:7f00:1]",
        // The NAT64 and 6to4 forms of private addresses.
        "[64:ff9b::10.0.0.1]",
        "[64:ff9b::127.0.0.1]",
        "[2002:c0a8:0001::1]",
        "[2002:7f00:0001::1]",
    ] {
        assert!(
            matches!(
                validate_public_host(host),
                Err(HostError::NonPublicAddress(_))
            ),
            "{host:?} must be refused as a non-public address"
        );
    }
    // The same forms of a public address pass.
    for host in [
        "[::ffff:93.184.216.34]",
        "[64:ff9b::8.8.8.8]",
        "[2002:5db8:d822::1]",
    ] {
        assert_eq!(validate_public_host(host), Ok(()), "{host:?}");
    }
}

#[test]
fn public_names_and_addresses_pass() {
    for host in [
        "api.example.com",
        "API.Example.COM",
        "smtp.example.com:465",
        "imap.mail.example.com.",
        "bücher.de",
        "xn--bcher-kva.de",
        "mail.localhost-example.com",
        "local.example.com",
        "8.8.8.8",
        "93.184.216.34:443",
        "1.1.1.1",
        "100.63.255.255",
        "100.128.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "192.169.0.1",
        "169.253.0.1",
        "223.255.255.255",
        "[2606:4700:4700::1111]",
        "[2001:4860:4860::8888]:443",
    ] {
        assert_eq!(validate_public_host(host), Ok(()), "{host:?}");
    }
}

#[test]
fn malformed_hosts_are_invalid_not_public() {
    assert_eq!(validate_public_host(""), Err(HostError::Empty));
    assert_eq!(validate_public_host("   "), Err(HostError::Empty));
    for host in [
        "not a host",
        "evil.example/path",
        "user@evil.example",
        "host:",
        "host:http",
        "::1",
        "[::1",
        "a..b",
        ".",
        "https://api.example.com",
    ] {
        assert!(
            matches!(validate_public_host(host), Err(HostError::Invalid(_))),
            "{host:?}: {:?}",
            validate_public_host(host)
        );
    }
}

#[test]
fn each_refusal_says_why() {
    assert!(matches!(
        validate_public_host("localhost"),
        Err(HostError::Localhost(_))
    ));
    assert!(matches!(
        validate_public_host("intranet"),
        Err(HostError::SingleLabel(_))
    ));
    assert!(matches!(
        validate_public_host("printer.local"),
        Err(HostError::PrivateSuffix(_, "local"))
    ));
    assert!(matches!(
        validate_public_host("10.1.2.3"),
        Err(HostError::NonPublicAddress(_))
    ));
    for (err, key) in [
        (HostError::Empty, "empty"),
        (HostError::Invalid("x".into()), "invalid"),
        (HostError::Localhost("localhost".into()), "localhost"),
        (HostError::SingleLabel("intranet".into()), "single_label"),
        (
            HostError::PrivateSuffix("a.lan".into(), "lan"),
            "private_suffix",
        ),
        (
            HostError::NonPublicAddress("10.0.0.1".parse().unwrap()),
            "non_public_address",
        ),
    ] {
        assert_eq!(err.key(), key);
        assert!(!err.to_string().is_empty());
    }
}
