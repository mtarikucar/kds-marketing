"""The speak image and its unit as shipped: no network, read-only and unprivileged at run time; the
base image, the packages and the weights pinned; only Antalia's normaliser in our code."""
import pathlib
import re

import pytest

SPEAK = pathlib.Path(__file__).resolve().parents[1]
UNIT_FILE = SPEAK.parent.parent / "deploy" / "jeeta-voice-speak.service"
if not UNIT_FILE.exists():  # inside the image, which holds neither the Dockerfile nor the unit
    pytest.skip("the repository's Dockerfile and unit are not here", allow_module_level=True)
DOCKERFILE = (SPEAK / "Dockerfile").read_text(encoding="utf-8")
UNIT = UNIT_FILE.read_text(encoding="utf-8")


def test_the_container_runs_without_network_read_only_and_unprivileged():
    for flag in [
        "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges",
        "--pids-limit 128", "--memory 2g", "--memory-swap 2g", "--cpus 2", "--user 1501:1501", "--init",
    ]:
        assert flag in UNIT, f"jeeta-voice-speak.service lacks {flag}"
    assert not re.search(r"\s(-p|--publish|--privileged|--cap-add|--network host)\b", UNIT)
    tmpfs = re.findall(r"--tmpfs (\S+)", UNIT)
    assert len(tmpfs) == 1 and tmpfs[0].startswith("/tmp:")
    assert {"noexec", "nosuid", "nodev"} <= set(tmpfs[0].split(":", 1)[1].split(","))
    assert re.findall(r"-v (\S+)", UNIT) == ["/run/jeeta-voice:/run/jeeta-voice"]
    assert "SPEAK_SOCKET=unix:/run/jeeta-voice/speak.sock" in UNIT
    assert "EMA_SEED=0" in UNIT
    assert re.search(r"^Restart=always$", UNIT, re.M)
    assert "${SPEAK_IMAGE}" in UNIT


def test_the_image_user_is_the_units():
    assert re.findall(r"^USER (\S+)$", DOCKERFILE, re.M) == ["1501:1501"]


def test_the_base_image_is_pinned_by_digest():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE, re.M)
    assert len(froms) == 1
    assert re.fullmatch(r"python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}", froms[0]), froms[0]


def test_packages_come_from_the_tested_set_as_wheels_and_are_recorded():
    install = re.search(r"^RUN pip install (.+?)(?<!\\)$", DOCKERFILE, re.M | re.S).group(1)
    for part in ["--only-binary=:all:", "-r requirements.txt", "-c constraints.txt", "--report"]:
        assert part in install
    assert "grep -qx 'ema-lightning==1.1.2' constraints.txt" in DOCKERFILE
    assert "pins.py wheels" in DOCKERFILE and "--expect wheels.sha256" in DOCKERFILE
    def listed(name):
        lines = (SPEAK / name).read_text(encoding="utf-8").splitlines()
        return [line.strip() for line in lines if line.strip() and not line.startswith("#")]

    requirements = listed("requirements.txt")
    assert "ema-lightning==1.1.2" in requirements and "antalia-mini==1.0.1" in requirements
    assert not any(r.startswith("normalizer-tr") for r in requirements)
    frozen = listed("constraints.txt")
    if frozen:  # filled in by B2 Step 7 from the owner-tested image
        assert "ema-lightning==1.1.2" in frozen and "antalia-mini==1.0.1" in frozen
        assert any(re.fullmatch(r"torch==\S+\+cpu", line) for line in frozen)


def test_the_weights_are_fetched_checked_and_offline_after():
    fetch = DOCKERFILE.index("python pins.py fetch-weights")
    offline = DOCKERFILE.index("HF_HUB_OFFLINE=1")
    assert fetch < offline < DOCKERFILE.index("python jeeta_speak.py --self-test") < DOCKERFILE.index("\nCMD ")
    assert "Antalia()" not in DOCKERFILE, "the normaliser is code only: no Antalia weights"


def test_every_copied_file_passes_the_dockerignore():
    allowed = {
        line[1:] for line in (SPEAK / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.startswith("!")
    }
    copied = [
        src for line in re.findall(r"^COPY (.+)$", DOCKERFILE, re.M) for src in line.split()[:-1]
    ]
    for src in copied:
        assert src in allowed or f"{src}/*.py" in allowed, f"{src} is not let through .dockerignore"
        assert (SPEAK / src).exists() or src == "pytest.ini", f"{src} does not exist"


def test_our_code_never_uses_normalizer_tr():
    # Owner decision (2026-10-29): normalizer-tr 0.8.1 read "14:00'e" as "on dört iki nokta sıfır
    # sıfır kesme e"; the normaliser is Antalia's.
    for name in ("jeeta_speak.py", "respell.py", "pins.py"):
        source = (SPEAK / name).read_text(encoding="utf-8")
        assert not re.search(r"^\s*(import|from)\s+normalizer_tr\b", source, re.M), name
    assert "Antalia.normalize" in (SPEAK / "jeeta_speak.py").read_text(encoding="utf-8")
