"""The Asterisk configuration shipped in the repository: no secret, loopback-only control,
no verbose console (dialplan lines carry phone numbers), extension 102 over UDP."""
import pathlib
import re

ETC = pathlib.Path(__file__).parent / "etc"


def read(name: str) -> str:
    return (ETC / name).read_text(encoding="utf-8")


def test_no_secret_lives_in_the_repository():
    for path in ETC.glob("*.conf"):
        for line in path.read_text(encoding="utf-8").splitlines():
            assert not re.match(r"\s*password\s*=", line), f"{path.name}: {line}"
    assert "#include secrets/pjsip_auth.conf" in read("pjsip.conf")
    assert "#include secrets/ari_users.conf" in read("ari.conf")


def test_control_binds_loopback_only():
    http = read("http.conf")
    assert re.search(r"^bindaddr\s*=\s*127\.0\.0\.1\s*$", http, re.M)
    assert re.search(r"^bindport\s*=\s*8188\s*$", http, re.M)


def test_console_logs_warnings_and_errors_only():
    assert re.search(r"^console\s*=>\s*warning,error\s*$", read("logger.conf"), re.M)
    assert re.search(r"^verbose\s*=\s*0\s*$", read("asterisk.conf"), re.M)
    assert re.search(r"^enable\s*=\s*no\s*$", read("cdr.conf"), re.M)
    assert re.search(r"^enable\s*=\s*no\s*$", read("cel.conf"), re.M)


def test_extension_102_registers_over_udp():
    pjsip = read("pjsip.conf")
    assert "client_uri=sip:102-8508407303@sip5.netsantral.com" in pjsip
    assert "server_uri=sip:sip5.netsantral.com" in pjsip
    assert "protocol=udp" in pjsip
    assert "bind=0.0.0.0:5070" in pjsip
    assert "allow=alaw,ulaw" in pjsip
    # Asterisk stops registering for good after max_retries (default 10) timeouts in a row: a
    # five-minute NetGSM outage must not leave the line unregistered until a restart.
    assert re.search(r"^max_retries=10000$", pjsip, re.M)
    rtp = read("rtp.conf")
    assert "rtpstart=40000" in rtp and "rtpend=40099" in rtp


def test_inbound_calls_enter_the_bridge_application():
    assert "Stasis(jeeta-voice,in)" in read("extensions.conf")
