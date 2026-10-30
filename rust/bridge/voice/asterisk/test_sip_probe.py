"""The SIP OPTIONS probe of B1 Step 9: one well-formed request, and only the status line back."""
import socket
import threading

from sip_probe import options, probe


def test_the_request_is_one_well_formed_options():
    raw = options("203.0.113.7", 5070, "netgsm", ("198.51.100.2", 40123), "abc123").decode("ascii")
    lines = raw.split("\r\n")
    assert lines[0] == "OPTIONS sip:203.0.113.7:5070 SIP/2.0"
    assert "Via: SIP/2.0/UDP 198.51.100.2:40123;branch=z9hG4bKabc123;rport" in lines
    assert "From: <sip:netgsm@probe.invalid>;tag=abc123" in lines
    assert "CSeq: 1 OPTIONS" in lines
    assert raw.endswith("Content-Length: 0\r\n\r\n")


def answer_once(reply: bytes) -> tuple[int, threading.Thread]:
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.bind(("127.0.0.1", 0))
    server.settimeout(5)

    def run():
        with server:
            request, peer = server.recvfrom(65535)
            assert request.startswith(b"OPTIONS ")
            server.sendto(b"SIP/2.0 100 Trying\r\n\r\n", peer)
            server.sendto(reply, peer)

    thread = threading.Thread(target=run)
    thread.start()
    return server.getsockname()[1], thread


def test_the_probe_prints_the_final_status_line_and_nothing_else():
    reply = (
        b"SIP/2.0 401 Unauthorized\r\n"
        b"From: <sip:05321234567@probe.invalid>;tag=x\r\n"
        b'WWW-Authenticate: Digest realm="asterisk",nonce="n"\r\n\r\n'
    )
    port, thread = answer_once(reply)
    assert probe("127.0.0.1", port, "netgsm") == "SIP/2.0 401 Unauthorized"
    thread.join()


def test_silence_reads_no_answer():
    closed = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    closed.bind(("127.0.0.1", 0))
    port = closed.getsockname()[1]
    with closed:  # bound but never answering
        assert probe("127.0.0.1", port, "netgsm", timeout_s=0.3) == "no answer"
