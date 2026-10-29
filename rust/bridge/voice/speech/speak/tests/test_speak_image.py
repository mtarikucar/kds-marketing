"""The speak image and its unit as shipped: no network, read-only and unprivileged at run time; the
base image, the packages and the weights pinned; only Antalia's normaliser in our code; the
approved texts the self-test reads are the policy's."""
import pathlib
import re
import shlex

import pytest

SPEAK = pathlib.Path(__file__).resolve().parents[1]
UNIT_FILE = SPEAK.parent.parent / "deploy" / "jeeta-voice-speak.service"
if not UNIT_FILE.exists():  # inside the image, which holds neither the Dockerfile nor the unit
    pytest.skip("the repository's Dockerfile and unit are not here", allow_module_level=True)
DOCKERFILE = (SPEAK / "Dockerfile").read_text(encoding="utf-8")
UNIT = UNIT_FILE.read_text(encoding="utf-8")
RUST_CALLS = SPEAK.parents[3] / "crates" / "domain" / "jt_calls" / "src"

# Every option of the unit's `docker run`, exactly: adding, dropping or changing one fails here.
RUN_OPTIONS = [
    "--rm", "--pull", "never", "--name", "jeeta-voice-speak", "--init", "--network", "none",
    "--user", "1502:1501", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--ulimit", "core=0", "--cpus", "2", "--cpu-shares", "2048",
    "--memory", "2g", "--memory-swap", "2g",
    "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
    "--tmpfs", "/tmp:uid=1502,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev",
    "--mount", "type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice",
    "-e", "SPEAK_SOCKET=unix:/run/jeeta-voice/speak.sock", "-e", "SPEAK_THREADS=2", "-e", "SPEAK_BATCH=2",
    "-e", "EMA_SEED=0", "-e", "SPEAK_WORKERS=2", "-e", "SPEAK_WATCHDOG_S=60",
    "${SPEAK_IMAGE}",
]


def exec_start():
    joined = re.sub(r"\\\n\s*", " ", UNIT)
    line = re.search(r"^ExecStart=(.+)$", joined, re.M).group(1)
    return shlex.split(line)


def test_the_container_runs_exactly_as_specified():
    argv = exec_start()
    assert argv[:2] == ["/usr/bin/docker", "run"]
    assert argv[2:] == RUN_OPTIONS
    assert re.search(r"^Restart=always$", UNIT, re.M)
    assert re.search(r"^StartLimitBurst=5$", UNIT, re.M)
    assert "SPEAK_WEIGHTS_LOCK" not in UNIT and "RESPELL_FILE" not in UNIT


def test_the_image_user_is_the_units():
    assert re.findall(r"^USER (\S+)$", DOCKERFILE, re.M) == ["1502:1501"]
    assert "useradd --uid 1502 --gid 1501" in DOCKERFILE and "groupadd --gid 1501 jeeta-voice" in DOCKERFILE


def test_the_base_image_is_pinned_by_digest():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE, re.M)
    assert len(froms) == 1
    assert re.fullmatch(r"python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}", froms[0]), froms[0]


def test_packages_install_only_from_the_hashed_locks_one_index_each():
    code = re.sub(r"\\\n\s*", " ", re.sub(r"^#.*\n", "", DOCKERFILE, flags=re.M))  # no comments, a RUN per line
    installs = re.findall(r"pip install (.+?) -r (\S+)", code)
    assert [lock for _, lock in installs] == ["torch.lock", "requirements.lock"]
    (torch_options, _), (rest_options, _) = installs
    for options in (torch_options, rest_options):
        for flag in ("--no-cache-dir", "--require-hashes", "--no-deps", "--only-binary=:all:"):
            assert flag in options.split()
        assert "--extra-index-url" not in options
    assert "--index-url https://download.pytorch.org/whl/cpu" in torch_options
    assert "--index-url https://pypi.org/simple" in rest_options
    assert re.search(r"&& pip check\s+&&", code) and "RUN python pins.py check-lock" in code
    assert code.index("pins.py check-lock") < code.index("pip install")
    assert "--expect wheels.sha256" in code
    assert "constraints.txt" not in code.split("pip install", 1)[1], "constraints only feed the locks"


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
    copied = [src for line in re.findall(r"^COPY (.+)$", DOCKERFILE, re.M) for src in line.split()[:-1]]
    for src in copied:
        assert src in allowed or f"{src}/*.py" in allowed, f"{src} is not let through .dockerignore"
        assert (SPEAK / src).exists() or src == "pytest.ini", f"{src} does not exist"


def test_production_reads_no_override_of_its_pinned_files():
    source = (SPEAK / "jeeta_speak.py").read_text(encoding="utf-8")
    assert "SPEAK_WEIGHTS_LOCK" not in source and "RESPELL_FILE" not in source
    knobs = set(re.findall(r'env_int\("([A-Z_]+)"', source)) | set(re.findall(r'os\.environ\.get\("([A-Z_]+)"', source))
    assert knobs == {"SPEAK_THREADS", "SPEAK_BATCH", "EMA_SEED", "SPEAK_WORKERS", "SPEAK_WATCHDOG_S", "SPEAK_SOCKET",
                     "SPEAK_LOG"}


def test_our_code_never_uses_normalizer_tr():
    # Owner decision (2026-10-29): normalizer-tr 0.8.1 read "14:00'e" as "on dört iki nokta sıfır
    # sıfır kesme e"; the normaliser is Antalia's.
    for name in ("jeeta_speak.py", "respell.py", "pins.py"):
        source = (SPEAK / name).read_text(encoding="utf-8")
        assert not re.search(r"^\s*(import|from)\s+normalizer_tr\b", source, re.M), name
    assert "Antalia.normalize" in (SPEAK / "jeeta_speak.py").read_text(encoding="utf-8")


def test_the_approved_texts_are_the_policys_defaults():
    import sys

    sys.path.insert(0, str(SPEAK))
    from jeeta_speak import APPROVED_TEXTS

    rust = "\n".join(
        (RUST_CALLS / name).read_text(encoding="utf-8") for name in ("opening.rs", "phrases.rs")
    )
    templates = re.findall(r'format!\("([^"]+)"', rust)
    for text in APPROVED_TEXTS:
        workspace = text.replace("Jeeta'nın", "{g}")
        literal = f'"{text}"' in rust
        templated = any(t.replace("{o}", "Merhaba, ben {g} dijital asistanıyım.") == workspace for t in templates)
        assert literal or templated, text
    phrases = re.findall(r'"([^"]+[.?!])"', (RUST_CALLS / "phrases.rs").read_text(encoding="utf-8"))
    assert set(phrases) <= set(APPROVED_TEXTS), set(phrases) - set(APPROVED_TEXTS)
