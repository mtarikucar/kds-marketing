//! MAC inputs and the public URL paths (spec §3.14).

use jt_outreach::*;
use jt_tenancy::WorkspaceId;
use uuid::Uuid;

#[test]
fn mac_inputs_differ_by_purpose_and_link() {
    // A token is the commercial email's outbox entry id (spec D63).
    let send = Uuid::from_u128(0x0102);
    let other = Uuid::from_u128(0x0103);
    let unsubscribe = mac_input(MacPurpose::Unsubscribe, send, None);
    let click0 = mac_input(MacPurpose::Click, send, Some(0));
    let click1 = mac_input(MacPurpose::Click, send, Some(1));
    let inputs = [
        unsubscribe.clone(),
        mac_input(MacPurpose::Unsubscribe, other, None),
        click0.clone(),
        click1.clone(),
        mac_input(MacPurpose::Click, other, Some(0)),
        mac_input(MacPurpose::Click, send, Some(256)),
        mac_input(MacPurpose::Click, send, None),
    ];
    for (i, a) in inputs.iter().enumerate() {
        for b in &inputs[i + 1..] {
            assert_ne!(a, b);
        }
    }
    // Fixed layout: the purpose label, a zero byte, the token's 16 bytes, then the link.
    let mut expected = b"outreach.unsubscribe\0".to_vec();
    expected.extend_from_slice(send.as_bytes());
    expected.push(0);
    assert_eq!(unsubscribe, expected);
    let mut expected = b"outreach.click\0".to_vec();
    expected.extend_from_slice(send.as_bytes());
    expected.extend_from_slice(&[1, 0, 1]);
    assert_eq!(click1, expected);
    assert_eq!(MacPurpose::Unsubscribe.key(), "outreach.unsubscribe");
    assert_eq!(MacPurpose::Click.key(), "outreach.click");
    assert_eq!(MAC_BYTES, 16);
}

#[test]
fn public_paths_name_the_workspace_the_send_and_the_mac() {
    let ws = WorkspaceId(Uuid::from_u128(1));
    let send = Uuid::from_u128(2);
    assert_eq!(
        unsubscribe_path(ws, send, "AbC-_9"),
        "/u/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/AbC-_9"
    );
    assert_eq!(
        click_path(ws, send, 3, "AbC-_9"),
        "/c/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/3/AbC-_9"
    );
}
