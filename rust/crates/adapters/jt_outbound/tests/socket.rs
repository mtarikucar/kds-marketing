use jt_outbound::{Egress, EgressScope};
use jt_tenancy::WorkspaceId;
use std::time::{Duration, Instant};
use tokio::net::{TcpSocket, TcpStream};

#[tokio::test]
async fn connect_tries_next_address_after_a_silent_one() {
    // Fill a real loopback listener's accept queue. Further SYNs are silently dropped,
    // independently of external routing/firewalls; retain every queued connection.
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.2:0".parse().unwrap()).unwrap();
    let silent = socket.listen(1).unwrap();
    let address = silent.local_addr().unwrap();
    let reachable = tokio::net::TcpListener::bind(("127.0.0.1", address.port()))
        .await
        .unwrap();
    let mut queued = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(100), TcpStream::connect(address)).await {
            Ok(Ok(stream)) => queued.push(stream),
            Err(_) => break,
            Ok(Err(err)) => panic!("expected a silently dropping listener: {err}"),
        }
        assert!(queued.len() < 16, "accept queue must become full");
    }
    let egress = Egress::with_test_lookup(&[], |_, port| {
        Box::pin(async move {
            Ok(vec![
                std::net::SocketAddr::from(([127, 0, 0, 2], port)),
                std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            ])
        })
    });
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "localhost");
    let start = Instant::now();
    let stream = egress
        .connect_public(
            EgressScope::Tenant(ws),
            "localhost",
            address.port(),
            Duration::from_secs(3),
        )
        .await
        .expect("the silent address must leave time for the reachable address");
    assert_eq!(stream.peer_addr().unwrap(), reachable.local_addr().unwrap());
    assert!(start.elapsed() < Duration::from_millis(2800));
    reachable.accept().await.unwrap();
}
