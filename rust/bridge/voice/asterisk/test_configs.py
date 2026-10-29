"""The Asterisk configuration shipped in the repository, and the container it runs in.

Invariants: no secret in the repository; control (ARI) on loopback only and no AMI; no verbose
console (dialplan lines carry phone numbers); one UDP transport and one endpoint, NetGSM's,
identified by its address only; a dialplan that can only hand a call to the bridge or hang it up;
state on tmpfs; a read-only, unprivileged container; every module the bridge needs built and
never disabled."""
import pathlib
import re

HERE = pathlib.Path(__file__).parent
ETC = HERE / "etc"
UNIT = HERE.parent / "deploy" / "jeeta-asterisk.service"
DOCKERFILE = HERE / "Dockerfile"

NETGSM_HOST = "sip5.netsantral.com"
CREDENTIAL_KEYS = {"password", "secret", "md5_cred", "password_digest", "oauth_secret", "refresh_token"}
ALLOWED_DIRECTIVES = {
    "pjsip.conf": ["#include secrets/pjsip_auth.conf"],
    "ari.conf": ["#include secrets/ari_users.conf"],
}
DIALPLAN_APPS = {"stasis", "hangup"}
# The modules the bridge cannot work without (B1 review); the Dockerfile checks each is built. The
# last three no module requires, but the configuration relies on them: the 401 challenge to an
# unidentified request, the endpoint's NAT options, and extensions.conf itself.
REQUIRED_MODULES = [
    "chan_websocket", "chan_pjsip", "res_pjsip", "res_pjsip_session", "res_pjsip_sdp_rtp",
    "res_pjsip_outbound_registration", "res_pjsip_outbound_authenticator_digest",
    "res_pjsip_endpoint_identifier_ip", "res_rtp_asterisk", "res_http_websocket",
    "res_websocket_client", "res_ari", "res_ari_asterisk", "res_ari_channels", "res_ari_bridges",
    "res_ari_events", "res_stasis", "app_stasis", "bridge_simple", "bridge_softmix",
    "res_timing_timerfd", "codec_alaw", "codec_ulaw",
    "res_pjsip_authenticator_digest", "res_pjsip_nat", "pbx_config",
]
# Files the loaded modules read, shipped so none logs a load error at start (B1 Step 9 run).
MODULE_CONFIGS = ["chan_websocket.conf", "pjproject.conf", "websocket_client.conf"]


def read(name: str) -> str:
    return (ETC / name).read_text(encoding="utf-8")


def strip_comment(raw: str) -> str:
    return raw.split(";", 1)[0].strip()


def sections(name: str) -> list[tuple[str, str | None, list[tuple[str, str]]]]:
    """The file's sections in order: (name, template suffix or None, [(key lowercased, value)])."""
    out: list[tuple[str, str | None, list[tuple[str, str]]]] = []
    for raw in read(name).splitlines():
        line = strip_comment(raw)
        if not line or line.startswith("#"):
            continue
        header = re.match(r"^\[([^\]]+)\]\s*(\(.*\))?$", line)
        if header:
            out.append((header.group(1).strip(), header.group(2), []))
            continue
        key, sep, value = line.partition("=")
        assert sep, f"{name}: not a key = value line: {line}"
        assert out, f"{name}: a setting before the first section: {line}"
        value = value[1:] if value.startswith(">") else value
        out[-1][2].append((key.strip().lower(), value.strip()))
    return out


def values(items: list[tuple[str, str]], key: str) -> list[str]:
    return [v for k, v in items if k == key]


def pjsip_of_type(kind: str) -> list[tuple[str, list[tuple[str, str]]]]:
    return [
        (name, items)
        for name, _, items in sections("pjsip.conf")
        if kind in [v.lower() for v in values(items, "type")]
    ]


def test_no_secret_lives_in_the_repository():
    for path in sorted(ETC.glob("*.conf")):
        for name, _, items in sections(path.name):
            for key, _ in items:
                assert key not in CREDENTIAL_KEYS, f"{path.name} [{name}] sets {key}"
        directives = [
            strip_comment(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip().startswith("#")
        ]
        assert directives == ALLOWED_DIRECTIVES.get(path.name, []), f"{path.name}: {directives}"


def test_control_binds_loopback_only_and_ami_is_off():
    http = sections("http.conf")
    assert [n for n, _, _ in http] == ["general"]
    general = http[0][2]
    assert values(general, "bindaddr") == ["127.0.0.1"]
    assert values(general, "bindport") == ["8188"]
    assert not [k for k, _ in general if k.startswith("tls")], "http.conf must not enable TLS"
    manager = sections("manager.conf")
    assert [n for n, _, _ in manager] == ["general"], "manager.conf holds no AMI user"
    assert values(manager[0][2], "enabled") == ["no"]


def test_console_logs_warnings_and_errors_only():
    assert re.search(r"^console\s*=>\s*warning,error\s*$", read("logger.conf"), re.M)
    assert re.search(r"^verbose\s*=\s*0\s*$", read("asterisk.conf"), re.M)
    assert re.search(r"^enable\s*=\s*no\s*$", read("cdr.conf"), re.M)
    assert re.search(r"^enable\s*=\s*no\s*$", read("cel.conf"), re.M)


def test_state_lives_on_the_run_tmpfs():
    directories = [(mark, items) for name, mark, items in sections("asterisk.conf") if name == "directories"]
    assert len(directories) == 1, "asterisk.conf has one [directories]"
    mark, items = directories[0]
    assert mark is None, f"[directories]{mark} is a template, which Asterisk does not apply"
    assert values(items, "astdbdir") == ["/var/run/asterisk"]
    assert values(items, "astrundir") == ["/var/run/asterisk"]


def test_extension_102_registers_over_one_udp_transport():
    for name, mark, items in sections("pjsip.conf"):
        assert mark is None, f"pjsip.conf [{name}] uses a template: {mark}"
        assert len(values(items, "type")) == 1, f"pjsip.conf [{name}] needs exactly one type"
    transports = pjsip_of_type("transport")
    assert len(transports) == 1, f"one transport, not {len(transports)}"
    _, transport = transports[0]
    assert values(transport, "protocol") == ["udp"]
    assert values(transport, "bind") == ["0.0.0.0:5070"]
    registrations = pjsip_of_type("registration")
    assert len(registrations) == 1
    _, reg = registrations[0]
    assert values(reg, "client_uri") == [f"sip:102-8508407303@{NETGSM_HOST}"]
    assert values(reg, "server_uri") == [f"sip:{NETGSM_HOST}"]
    # A 403 stops for good; timeouts and 5xx are retried for days, not stopped after ten tries.
    assert values(reg, "forbidden_retry_interval") == ["0"]
    assert values(reg, "max_retries") == ["10000"]
    assert values(reg, "auth_rejection_permanent") in ([], ["yes"])
    rtp = read("rtp.conf")
    assert "rtpstart=40000" in rtp and "rtpend=40099" in rtp


def test_the_only_endpoint_is_netgsm_identified_by_its_address():
    names = [name.lower() for name, _, _ in sections("pjsip.conf")]
    assert "anonymous" not in names, "an [anonymous] endpoint would take unidentified requests"
    endpoints = pjsip_of_type("endpoint")
    assert [name for name, _ in endpoints] == ["netgsm"], f"endpoints: {[n for n, _ in endpoints]}"
    _, endpoint = endpoints[0]
    assert values(endpoint, "identify_by") == ["ip"]
    assert values(endpoint, "allow_transfer") == ["no"]
    assert values(endpoint, "context") == ["jeeta-in"]
    assert not values(endpoint, "auth"), "no inbound auth object: identification is by address"
    keys = [k for k, _ in endpoint]
    assert values(endpoint, "disallow") == ["all"]
    assert keys.index("disallow") < keys.index("allow"), "disallow=all must come before allow"
    every_allow = [v for _, _, items in sections("pjsip.conf") for v in values(items, "allow")]
    assert every_allow == ["alaw,ulaw"], f"allow: {every_allow}"
    identifies = pjsip_of_type("identify")
    assert len(identifies) == 1
    _, identify = identifies[0]
    assert values(identify, "endpoint") == ["netgsm"]
    (match,) = values(identify, "match")
    entries = [e.strip() for e in match.split(",")]
    assert entries[0] == NETGSM_HOST, f"match starts with {entries[0]}"
    for entry in entries[1:]:
        address = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3})(?:/(\d{1,2}))?", entry)
        assert address, f"match entry {entry}: a host address or a /24-/32 network only"
        assert int(address.group(2) or 32) >= 24, f"match entry {entry} is too wide"


def test_inbound_calls_can_only_enter_the_bridge_application():
    plan = sections("extensions.conf")
    assert [name for name, _, _ in plan] == ["general", "jeeta-in"]
    apps = []
    for key, value in plan[1][2]:
        assert key in {"exten", "same"}, f"extensions.conf: {key} => {value}"
        fields = value.split(",", 2 if key == "exten" else 1)
        app = re.match(r"\s*([A-Za-z_]+)", fields[-1])
        assert app, f"extensions.conf: no application in {value}"
        apps.append(app.group(1).lower())
    assert set(apps) <= DIALPLAN_APPS, f"applications: {sorted(set(apps))}"
    assert "stasis" in apps
    assert "Stasis(jeeta-voice,in)" in read("extensions.conf")


def test_the_container_runs_read_only_and_unprivileged():
    unit = UNIT.read_text(encoding="utf-8")
    for flag in [
        "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256",
        "--network host", "--user 1500:1500", "--init",
    ]:
        assert flag in unit, f"jeeta-asterisk.service lacks {flag}"
    assert "/var/lib/asterisk" not in unit, "no persistent volume: state lives on tmpfs"
    tmpfs = re.findall(r"--tmpfs (\S+)", unit)
    assert len(tmpfs) == 3
    for mount in tmpfs:
        options = mount.split(":", 1)[1].split(",")
        assert {"noexec", "nosuid", "nodev"} <= set(options), f"{mount}"
    assert "/etc/jeeta-voice/asterisk:/etc/asterisk:ro" in unit
    assert re.search(r"^Restart=always$", unit, re.M)


def test_every_module_the_bridge_needs_is_built_and_never_disabled():
    modules = sections("modules.conf")
    noload = {v.removesuffix(".so") for _, _, items in modules for v in values(items, "noload")}
    assert not noload & set(REQUIRED_MODULES), f"disabled: {sorted(noload & set(REQUIRED_MODULES))}"
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    checked = re.search(r"for m in ([^;]+);", dockerfile)
    assert checked, "the Dockerfile checks the required modules in a `for m in ...;` loop"
    assert [t for t in checked.group(1).split() if t != "\\"] == REQUIRED_MODULES
    for name in MODULE_CONFIGS:
        assert (ETC / name).is_file(), f"{name} is missing: its module logs a load error"
    websocket = sections("chan_websocket.conf")
    assert [(n, values(items, "control_message_format")) for n, _, items in websocket] == [
        ("global", ["json"])
    ]


def test_the_base_images_are_pinned_by_digest():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE.read_text(encoding="utf-8"), re.M)
    assert len(froms) == 2, froms
    for image in froms:
        assert re.fullmatch(r"debian:bookworm-slim@sha256:[0-9a-f]{64}", image), image
