"""The listen image and its unit as shipped: no network, read-only and unprivileged at run time, its
own uid beside speak's in the shared group; the base image, the packages and the models pinned; no
package beyond the lock and nothing downloaded once the models are in."""
import pathlib
import re
import shlex

import pytest

LISTEN = pathlib.Path(__file__).resolve().parents[1]
VOICE = LISTEN.parent.parent
UNIT_FILE = VOICE / "deploy" / "jeeta-voice-listen.service"
if not UNIT_FILE.exists():  # inside the image, which holds neither the Dockerfile nor the unit
    pytest.skip("the repository's Dockerfile and unit are not here", allow_module_level=True)
DOCKERFILE = (LISTEN / "Dockerfile").read_text(encoding="utf-8")
UNIT = UNIT_FILE.read_text(encoding="utf-8")
SPEAK_DOCKERFILE = (LISTEN.parent / "speak" / "Dockerfile").read_text(encoding="utf-8")
SPEAK_UNIT = (VOICE / "deploy" / "jeeta-voice-speak.service").read_text(encoding="utf-8")
SERVICE_CODE = ["jeeta_listen.py", "endpoint.py", "hotwords.py", "features.py", "vad.py", "turn.py", "asr.py",
                "listen_pins.py"]

# Every option of the unit's `docker run`, exactly: adding, dropping or changing one fails here.
RUN_OPTIONS = [
    "--rm", "--pull", "never", "--name", "jeeta-voice-listen", "--init", "--network", "none",
    "--user", "1501:1501", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "64", "--ulimit", "core=0", "--cpus", "1.5", "--cpu-shares", "2048",
    "--memory", "1g", "--memory-swap", "1g",
    "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
    "--tmpfs", "/tmp:uid=1501,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev",
    "--mount", "type=bind,source=/run/jeeta-voice/listen,target=/run/jeeta-voice/listen",
    "-e", "LISTEN_SOCKET=unix:/run/jeeta-voice/listen/listen.sock", "-e", "LISTEN_THREADS=2",
    "-e", "LISTEN_WATCHDOG_S=30", "-e", "LISTEN_FALLBACK_MS=1500", "-e", "LISTEN_DIGITS_FALLBACK_MS=2800",
    "-e", "LISTEN_GUARD_TAIL_MS=400",
    "${LISTEN_IMAGE}",
]
# What .dockerignore lets through, exactly.
ALLOWED = {
    "requirements.txt", "constraints.txt", "wheels.sha256", "requirements.lock", "listen_pins.py", "models.lock",
    "endpoint.py", "hotwords.py", "features.py", "vad.py", "turn.py", "asr.py", "jeeta_listen.py", "THIRD_PARTY.md",
    "pytest.ini", "tests/*.py", "tests/fixtures/*.alaw", "tests/fixtures/*.json",
}


def exec_start(unit):
    joined = re.sub(r"\\\n\s*", " ", unit)
    return shlex.split(re.search(r"^ExecStart=(.+)$", joined, re.M).group(1))


def code(dockerfile):
    """The Dockerfile without comments, one instruction per line."""
    return re.sub(r"\\\n\s*", " ", re.sub(r"^#.*\n", "", dockerfile, flags=re.M))


def test_the_container_runs_exactly_as_specified():
    argv = exec_start(UNIT)
    assert argv[:2] == ["/usr/bin/docker", "run"]
    assert argv[2:] == RUN_OPTIONS
    assert re.search(r"^Restart=always$", UNIT, re.M)
    assert re.search(r"^StartLimitBurst=5$", UNIT, re.M)
    assert re.search(r"^EnvironmentFile=/etc/jeeta-voice/images.env$", UNIT, re.M)
    assert re.search(r"^RestartPreventExitStatus=78$", UNIT, re.M), "a socket held by another user: fail once"


def test_the_unit_sets_every_knob_the_service_reads():
    source = (LISTEN / "jeeta_listen.py").read_text(encoding="utf-8")
    knobs = set(re.findall(r'env_int\("([A-Z_]+)"', source))
    set_by_unit = {a.split("=", 1)[0] for a in exec_start(UNIT) if a.startswith("LISTEN_")}
    assert knobs <= set_by_unit, knobs - set_by_unit


def test_the_image_user_is_the_units_and_not_speaks():
    assert re.findall(r"^USER (\S+)$", DOCKERFILE, re.M) == ["1501:1501"]
    assert "useradd --uid 1501 --gid 1501" in DOCKERFILE and "groupadd --gid 1501 jeeta-voice" in DOCKERFILE
    speak_user = exec_start(SPEAK_UNIT)[exec_start(SPEAK_UNIT).index("--user") + 1]
    listen_user = RUN_OPTIONS[RUN_OPTIONS.index("--user") + 1]
    assert speak_user.split(":")[0] != listen_user.split(":")[0], "the sticky directory needs two owners"
    assert speak_user.split(":")[1] == listen_user.split(":")[1] == "1501", "one group for both sockets"
    tmpfiles = (VOICE / "deploy" / "jeeta-voice.tmpfiles").read_text(encoding="utf-8").splitlines()
    assert tmpfiles == ["d /run/jeeta-voice 1770 root jeeta-voice -",
                        "d /run/jeeta-voice/listen 0710 jeeta-voice-svc jeeta-voice -"]
    mount = RUN_OPTIONS[RUN_OPTIONS.index("--mount") + 1]
    assert mount == "type=bind,source=/run/jeeta-voice/listen,target=/run/jeeta-voice/listen", \
        "listen sees its own directory only: speak cannot bind its name, it cannot reach speak's"


def test_the_base_image_is_pinned_by_digest_and_is_speaks():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE, re.M)
    assert len(froms) == 1
    assert re.fullmatch(r"python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}", froms[0]), froms[0]
    assert froms == re.findall(r"^FROM\s+(\S+)", SPEAK_DOCKERFILE, re.M), "the two images share their base"


def test_packages_install_only_from_the_hashed_lock_from_pypi_alone():
    c = code(DOCKERFILE)
    installs = re.findall(r"pip install (.+?) -r (\S+)", c)
    assert [lock for _, lock in installs] == ["requirements.lock"]
    options = installs[0][0].split()
    for flag in ("--no-cache-dir", "--require-hashes", "--no-deps", "--only-binary=:all:"):
        assert flag in options
    assert "--index-url https://pypi.org/simple" in installs[0][0] and "--extra-index-url" not in c
    assert re.search(r"&& pip check\s+&&", c) and "RUN python listen_pins.py check-lock" in c
    assert c.index("listen_pins.py check-lock") < c.index("pip install")
    assert "--expect wheels.sha256" in c
    assert "constraints.txt" not in c.split("pip install", 1)[1], "constraints only feed the lock"
    assert c.count("pip install") == 1


def test_the_models_are_fetched_checked_and_nothing_is_downloaded_after():
    c = code(DOCKERFILE)
    line = "RUN python listen_pins.py fetch-models /models"
    fetch = c.index(line)
    assert fetch < c.index("python jeeta_listen.py --self-test") < c.index("\nCMD ")
    after = c[fetch + len(line):]
    for word in ("pip ", "curl", "wget", "fetch", "hf_hub", "huggingface"):
        assert word not in after, word
    assert "LISTEN_MODELS=/models" in c


def test_every_copied_file_passes_the_dockerignore():
    allowed = {
        line[1:] for line in (LISTEN / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.startswith("!")
    }
    assert allowed == ALLOWED
    copied = [src for line in re.findall(r"^COPY (.+)$", DOCKERFILE, re.M) for src in line.split()[:-1]]
    for src in copied:
        assert src in allowed or f"{src}/*.py" in allowed, f"{src} is not let through .dockerignore"
        assert (LISTEN / src).exists() or src == "pytest.ini", f"{src} does not exist"
    for name in SERVICE_CODE:
        assert name in copied, name
    assert {"tests/fixtures/*.alaw", "tests/fixtures/*.json"} <= allowed, "the model tests need their audio"


def test_production_reads_no_override_of_its_pinned_files():
    source = (LISTEN / "jeeta_listen.py").read_text(encoding="utf-8")
    knobs = set(re.findall(r'env_int\("([A-Z_]+)"', source)) | set(re.findall(r'os\.environ\.get\("([A-Z_]+)"', source))
    assert knobs == {"LISTEN_THREADS", "LISTEN_WATCHDOG_S", "LISTEN_FALLBACK_MS", "LISTEN_DIGITS_FALLBACK_MS",
                     "LISTEN_GUARD_TAIL_MS", "LISTEN_SOCKET", "LISTEN_LOG", "LISTEN_MODELS"}
    for name in SERVICE_CODE:
        text = (LISTEN / name).read_text(encoding="utf-8")
        assert "os.environ" not in text or name == "jeeta_listen.py", name


def test_the_service_imports_no_package_beyond_the_lock():
    # Smart Turn's features are ours (features.py); Silero's ONNX file is a model, not a package.
    for name in SERVICE_CODE:
        text = (LISTEN / name).read_text(encoding="utf-8")
        for banned in ("transformers", "torch", "huggingface_hub", "silero_vad", "requests", "sedalib"):
            assert not re.search(rf"^\s*(import|from)\s+{banned}\b", text, re.M), (name, banned)
    import sys

    sys.path.insert(0, str(LISTEN))
    import listen_pins

    required = listen_pins.read_pins((LISTEN / "requirements.txt").read_text(encoding="utf-8"), "r")
    assert set(required) == {"sherpa-onnx", "onnxruntime", "soxr", "numpy", "websockets", "pytest"}


def test_the_fixtures_reach_the_image_and_nothing_else_does():
    ignore = (LISTEN / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert ignore[1] == "*"
    for path in (LISTEN / "tests" / "fixtures").iterdir():
        assert path.suffix in (".alaw", ".json"), path.name


def test_one_blas_thread_and_a_health_check():
    env = re.search(r"^ENV (.+?)$", code(DOCKERFILE), re.M).group(1).split()
    assert "OPENBLAS_NUM_THREADS=1" in env and "OMP_NUM_THREADS=1" in env, "set before anything imports numpy"
    health = " ".join(re.search(r"^HEALTHCHECK (.+)$", code(DOCKERFILE), re.M).group(1).split())
    assert health == ('--interval=30s --timeout=10s --start-period=60s --retries=3 '
                      'CMD ["python", "jeeta_listen.py", "--health"]')


def test_the_third_party_notices_ship_and_name_every_model():
    import sys

    sys.path.insert(0, str(LISTEN))
    import listen_pins

    assert "COPY THIRD_PARTY.md ./" in DOCKERFILE
    text = (LISTEN / "THIRD_PARTY.md").read_text(encoding="utf-8")
    for source in listen_pins.SOURCES.values():
        assert source.get("revision", source.get("version")) in text
    for licence in ("Apache-2.0", "CC BY-SA 4.0", "BSD-2-Clause", "MIT", "LGPL-2.1-or-later"):
        assert licence in text, licence
    lock = listen_pins.load_lock()
    assert lock["files"]["silero-vad/silero_vad.onnx"]["archive_sha256"] in text
    for name in sorted(listen_pins.read_pins((LISTEN / "constraints.txt").read_text(encoding="utf-8"), "c")):
        assert name.replace("-", "").lower() in text.replace("-", "").lower(), name
