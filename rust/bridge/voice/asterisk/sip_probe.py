"""One SIP OPTIONS to host:port; prints only the answer's status line (never a header, which
could carry a number), or `no answer` after the timeout. Standard library only (B1 Step 9).

    python3 sip_probe.py <host> <port> <from-user>
"""
import secrets
import socket
import sys


def options(host: str, port: int, from_user: str, local: tuple[str, int], tag: str) -> bytes:
    """An OPTIONS from <sip:from_user@probe.invalid>, answered to `local` (rport)."""
    local_host, local_port = local[0], local[1]
    return (
        f"OPTIONS sip:{host}:{port} SIP/2.0\r\n"
        f"Via: SIP/2.0/UDP {local_host}:{local_port};branch=z9hG4bK{tag};rport\r\n"
        "Max-Forwards: 70\r\n"
        f"From: <sip:{from_user}@probe.invalid>;tag={tag}\r\n"
        f"To: <sip:{host}:{port}>\r\n"
        f"Call-ID: {tag}@probe.invalid\r\n"
        "CSeq: 1 OPTIONS\r\n"
        "User-Agent: jeeta-sip-probe\r\n"
        "Content-Length: 0\r\n"
        "\r\n"
    ).encode("ascii")


def status_line(reply: bytes) -> str:
    """The reply's first line when it is a SIP answer; nothing else of it."""
    first = reply.split(b"\r\n", 1)[0].decode("ascii", "replace")
    return first if first.startswith("SIP/2.0 ") else "not a SIP answer"


def probe(host: str, port: int, from_user: str, timeout_s: float = 3.0) -> str:
    """The final answer's status line (a provisional 1xx is skipped), or `no answer`."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout_s)
        s.connect((host, port))
        s.send(options(host, port, from_user, s.getsockname(), secrets.token_hex(8)))
        for _ in range(3):
            try:
                line = status_line(s.recv(65535))
            except OSError:  # timeout, or an ICMP port unreachable
                return "no answer"
            if not line.startswith("SIP/2.0 1"):
                return line
        return "no answer"


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: sip_probe.py <host> <port> <from-user>")
    print(probe(sys.argv[1], int(sys.argv[2]), sys.argv[3]))
