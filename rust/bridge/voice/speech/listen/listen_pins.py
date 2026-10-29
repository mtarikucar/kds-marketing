"""What the listen image pins, and the checks that hold it to them. Standard library only: the build
runs `check-lock` before anything is installed and `fetch-models` before the service's code is in.

Packages. requirements.txt pins, by exact version, every package the service imports and pytest;
constraints.txt is the frozen resolution of it in the base image (`pip freeze`, B3 bootstrap);
wheels.sha256 records every wheel of that resolution (name, version, sha256). The build installs
only from requirements.lock (PyPI alone, `--require-hashes --no-deps`, wheels only), which `lock`
writes from wheels.sha256. `check-lock` refuses a lock that is not exactly wheels.sha256, a frozen
set the lock does not hold exactly, and a requirement that is not pinned or that the lock pins
otherwise. `wheels` turns the build's pip report into the same lines and, against an --expect file,
refuses any difference or unknown hash.

Models. models.lock pins every file the service loads (MODEL_FILES) by URL, SHA-256 and size: a
Hugging Face file at a fixed 40-hex revision, or a member of a PyPI wheel (Silero VAD's ONNX file,
which the silero-vad wheel ships; the wheel itself requires torch, so it is never installed). The
build downloads, checks and writes them (`fetch-models DEST`), the service checks them again before
it loads them (`verify`), and `resolve` (a dev machine, with network) writes models.lock from the
revisions in SOURCES.

Usage: python listen_pins.py check-lock | lock | fetch-models [DEST] | verify [DEST] | resolve
       python listen_pins.py wheels REPORT.json [REPORT.json ...] [--expect wheels.sha256]
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK = HERE / "models.lock"
DEFAULT_MODELS = "/models"
HEX64 = re.compile(r"[0-9a-f]{64}")
HEX40 = re.compile(r"[0-9a-f]{40}")
PYPI_INDEX = "https://pypi.org/simple"

# Where each model comes from (plan V1-T3 B3): the revision is the repository's head when it was
# pinned; `resolve` reads every file's digest at that revision.
SOURCES = {
    "seda-v0.1": {"repo": "atasoglu/seda-v0.1", "revision": "5cbbda1b34bde5e3004e79b137dc3871587ea282",
                  "files": ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt",
                            "lm/rnnlm.int8.onnx", "lm/2gram.fst"]},
    "smart-turn": {"repo": "pipecat-ai/smart-turn-v3", "revision": "f766f81d3cfdf7737ac64aad813d91bbfd56bf93",
                   "files": ["smart-turn-v3.2-cpu.onnx"]},
    "silero-vad": {"wheel": "silero-vad", "version": "6.2.3",
                   "members": {"silero_vad.onnx": "silero_vad/data/silero_vad.onnx"}},
}
# Every file the service loads, under the models directory.
MODEL_FILES = frozenset(
    f"{target}/{name}"
    for target, source in SOURCES.items()
    for name in (source["files"] if "files" in source else source["members"])
)
HOSTS = {"huggingface.co", "files.pythonhosted.org"}
CHUNK = 1 << 20
# The most any download may bring: a pinned file its pinned size, a wheel or a lookup this much.
MAX_DOWNLOAD = 64 << 20


class PinError(Exception):
    """A pinned file is missing or differs (the message names the file, never a path's content)."""


def canonical(name):
    """A project name the way PyPI compares them (PEP 503)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


# --- packages ------------------------------------------------------------------------------------


def listed(text):
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def read_pins(text, what):
    """name -> version of `name==version` lines (anything after the version is ignored)."""
    pins = {}
    for line in listed(text):
        m = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)(?:\s.*)?", line)
        if not m:
            raise PinError(f"{what}: not a name==version line: {line.split()[0]}")
        name = canonical(m.group(1))
        if name in pins:
            raise PinError(f"{what}: {name} is listed twice")
        pins[name] = m.group(2)
    return pins


def read_record(text, what):
    """name -> (version, sha256) of `name==version sha256=<hex>` lines (wheels.sha256)."""
    out = {}
    for line in listed(text):
        m = re.fullmatch(r"(\S+)==(\S+) sha256=(\S+)", line)
        if not m or not HEX64.fullmatch(m.group(3)):
            raise PinError(f"{what}: a line has no name==version sha256=<hex>")
        out[canonical(m.group(1))] = (m.group(2), m.group(3))
    return out


def read_lock(text, what):
    """name -> (version, sha256) of `name==version --hash=sha256:<hex>` lines."""
    out = {}
    for line in listed(text):
        m = re.fullmatch(r"(\S+)==(\S+) --hash=sha256:([0-9a-f]{64})", line)
        if not m:
            raise PinError(f"{what}: a line has no name==version --hash=sha256:<hex>")
        out[canonical(m.group(1))] = (m.group(2), m.group(3))
    return out


def lock_text(record):
    head = ("# Generated by `python listen_pins.py lock` from wheels.sha256; installed --require-hashes"
            f" --no-deps from {PYPI_INDEX} alone.")
    lines = [f"{name}=={version} --hash=sha256:{digest}" for name, (version, digest) in sorted(record.items())]
    return "\n".join([head, *lines]) + "\n"


def check_lock(folder=HERE):
    """Every package rule of the module docstring, over the files in `folder`; returns the locked set."""
    read = lambda name: (folder / name).read_text(encoding="utf-8")  # noqa: E731
    frozen = read_pins(read("constraints.txt"), "constraints.txt")
    record = read_record(read("wheels.sha256"), "wheels.sha256")
    locked = read_lock(read("requirements.lock"), "requirements.lock")
    if locked != record:
        names = sorted({n for n, _ in set(locked.items()) ^ set(record.items())})
        raise PinError("requirements.lock differs from wheels.sha256: " + ", ".join(names))
    if set(frozen) != set(locked):
        raise PinError("the lock and constraints.txt name other packages: "
                       + ", ".join(sorted(set(frozen) ^ set(locked))))
    for name, version in frozen.items():
        if locked[name][0] != version:
            raise PinError(f"the lock does not hold {name}=={version} from constraints.txt")
    required = read_pins(read("requirements.txt"), "requirements.txt")
    if not required:
        raise PinError("requirements.txt pins nothing")
    for name, version in required.items():
        if locked.get(name, (None,))[0] != version:
            raise PinError(f"the lock does not satisfy {name}=={version} from requirements.txt")
    return locked


def wheels(report):
    """`name==version sha256=<hex>` per installed distribution of a `pip install --report`, sorted."""
    lines = []
    for item in report.get("install", []):
        meta, info = item.get("metadata", {}), item.get("download_info", {})
        archive = info.get("archive_info", {})
        digest = archive.get("hashes", {}).get("sha256")
        if not digest and str(archive.get("hash", "")).startswith("sha256="):
            digest = archive["hash"].split("=", 1)[1]
        lines.append(f"{canonical(meta['name'])}=={meta['version']} sha256={digest or '?'}")
    return sorted(lines)


# --- models --------------------------------------------------------------------------------------


def hf_url(repo, revision, name):
    return f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(name)}"


def check_url(name, url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in HOSTS or parts.query or parts.fragment:
        raise PinError(f"models.lock: {name} is not fetched over https from a pinned host")
    if parts.hostname == "huggingface.co" and not re.fullmatch(r"/[^/]+/[^/]+/resolve/[0-9a-f]{40}/.+", parts.path):
        raise PinError(f"models.lock: {name} is not at a fixed revision")
    if parts.hostname == "files.pythonhosted.org" and not parts.path.endswith(".whl"):
        raise PinError(f"models.lock: {name} does not come from a wheel")


def load_lock(path=LOCK):
    with open(path, encoding="utf-8") as f:
        lock = json.load(f)
    files = lock.get("files")
    if not isinstance(files, dict) or set(files) != MODEL_FILES:
        raise PinError("models.lock must pin exactly " + ", ".join(sorted(MODEL_FILES)))
    for name, entry in files.items():
        if not isinstance(entry, dict):
            raise PinError(f"models.lock: {name} has no entry")
        check_url(name, str(entry.get("url", "")))
        if not HEX64.fullmatch(str(entry.get("sha256", ""))):
            raise PinError(f"models.lock: {name} has no sha256")
        if not isinstance(entry.get("size"), int) or isinstance(entry["size"], bool) or entry["size"] <= 0:
            raise PinError(f"models.lock: {name} has no size")
        wheel = urllib.parse.urlsplit(entry["url"]).hostname == "files.pythonhosted.org"
        if wheel != ("member" in entry):
            raise PinError(f"models.lock: {name} names a member only when it comes from a wheel")
        if wheel and (not HEX64.fullmatch(str(entry.get("archive_sha256", "")))
                      or not isinstance(entry.get("member"), str) or not entry["member"]):
            raise PinError(f"models.lock: {name} has no wheel sha256 or member")
    return lock


def verify(lock, dest=DEFAULT_MODELS):
    """Every pinned file is under `dest` with its size and SHA-256; returns name -> sha256."""
    digests = {}
    for name, entry in sorted(lock["files"].items()):
        path = Path(dest) / name
        if not path.is_file():
            raise PinError(f"{name}: not in the models directory")
        if path.stat().st_size != entry["size"]:
            raise PinError(f"{name}: size differs from models.lock")
        digest = sha256_of(path)
        if digest != entry["sha256"]:
            raise PinError(f"{name}: sha256 differs from models.lock")
        digests[name] = digest
    return digests


def download(url, out, opener=urllib.request.urlopen, limit=MAX_DOWNLOAD):
    """Streams `url` into the open binary file `out`, refusing more than `limit` bytes; returns
    (sha256, size)."""
    h, size = hashlib.sha256(), 0
    with opener(urllib.request.Request(url, headers={"User-Agent": "jeeta-voice-listen-build"}), timeout=120) as r:
        for block in iter(lambda: r.read(CHUNK), b""):
            size += len(block)
            if size > limit:
                raise PinError(f"a download is larger than {limit} bytes")
            h.update(block)
            out.write(block)
    return h.hexdigest(), size


def fetch(lock, dest=DEFAULT_MODELS, opener=urllib.request.urlopen):
    """Build time, with network: download every pinned file, refuse any that differs, then verify."""
    archives = {}
    for name, entry in sorted(lock["files"].items()):
        path = Path(dest) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if "member" in entry:
            url = entry["url"]
            if url not in archives:
                buf = io.BytesIO()
                digest, _ = download(url, buf, opener)
                if digest != entry["archive_sha256"]:
                    raise PinError(f"{name}: the wheel's sha256 differs from models.lock")
                archives[url] = buf
            with zipfile.ZipFile(archives[url]) as z:
                try:
                    data = z.read(entry["member"])
                except KeyError:
                    raise PinError(f"{name}: the wheel has no such member") from None
            if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise PinError(f"{name}: the wheel's member differs from models.lock")
            path.write_bytes(data)
            os.chmod(path, 0o644)
            continue
        fd, part = tempfile.mkstemp(dir=path.parent, prefix=".part-")
        try:
            with os.fdopen(fd, "wb") as out:
                digest, size = download(entry["url"], out, opener, limit=entry["size"])
            if size != entry["size"] or digest != entry["sha256"]:
                raise PinError(f"{name}: the download differs from models.lock")
            # Fetched as root at build, read as the service's user: world-readable, owner-written.
            os.chmod(part, 0o644)
            os.replace(part, path)
        finally:
            if os.path.exists(part):
                os.unlink(part)
    return verify(lock, dest)


def _json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def resolve():
    """Dev machine, with network: models.lock from SOURCES (each file's digest at its revision)."""
    files = {}
    for target, source in SOURCES.items():
        if "repo" in source:
            tree = _json(f"https://huggingface.co/api/models/{source['repo']}/tree/{source['revision']}?recursive=true")
            listing = {e["path"]: e for e in tree if e.get("type") == "file"}
            for name in source["files"]:
                url = hf_url(source["repo"], source["revision"], name)
                lfs = listing[name].get("lfs")
                if lfs:
                    digest, size = lfs["oid"], lfs["size"]
                else:
                    digest, size = download(url, io.BytesIO(), limit=MAX_DOWNLOAD)
                files[f"{target}/{name}"] = {"url": url, "sha256": digest, "size": size}
            continue
        meta = _json(f"https://pypi.org/pypi/{source['wheel']}/{source['version']}/json")
        (wheel,) = [u for u in meta["urls"] if u["filename"].endswith("-py3-none-any.whl")]
        buf = io.BytesIO()
        digest, _ = download(wheel["url"], buf)
        if digest != wheel["digests"]["sha256"]:
            raise PinError(f"{target}: the wheel differs from PyPI's digest")
        with zipfile.ZipFile(buf) as z:
            for name, member in source["members"].items():
                data = z.read(member)
                files[f"{target}/{name}"] = {"url": wheel["url"], "archive_sha256": digest, "member": member,
                                             "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    return {"files": dict(sorted(files.items()))}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="listen_pins.py")
    parser.add_argument("action", choices=["check-lock", "lock", "fetch-models", "verify", "resolve", "wheels"])
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--expect")
    args = parser.parse_args(argv)
    try:
        if args.action == "check-lock":
            print(f"locks: ok ({len(check_lock())} wheels)")
        elif args.action == "lock":
            record = read_record((HERE / "wheels.sha256").read_text(encoding="utf-8"), "wheels.sha256")
            (HERE / "requirements.lock").write_text(lock_text(record), encoding="utf-8", newline="\n")
        elif args.action == "resolve":
            LOCK.write_text(json.dumps(resolve(), indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        elif args.action == "wheels":
            got = []
            for path in args.paths:
                with open(path, encoding="utf-8") as f:
                    got.extend(wheels(json.load(f)))
            got.sort()
            if args.expect:
                want = sorted(listed(Path(args.expect).read_text(encoding="utf-8")))
                if any(line.endswith("sha256=?") for line in got):
                    raise PinError("a wheel was installed without a known sha256")
                if want != got:
                    names = sorted({line.split("==")[0] for line in set(want) ^ set(got)})
                    raise PinError("the installed wheels differ from wheels.sha256: " + ", ".join(names))
            print("# pip install --report of the listen image: one installed wheel per line")
            print("\n".join(got))
        else:
            lock = load_lock()
            dest = args.paths[0] if args.paths else DEFAULT_MODELS
            digests = fetch(lock, dest) if args.action == "fetch-models" else verify(lock, dest)
            print(f"models: ok ({len(digests)} files)")
    except PinError as e:
        print(f"pins: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
