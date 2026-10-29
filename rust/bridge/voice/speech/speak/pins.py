"""What the speak image pins besides package versions: EMA Lightning's weights by content, and the
sha256 of every wheel the build installed.

EMA() downloads its two weight files from its repository's main branch and takes no revision, so
the weights are pinned by SHA-256 and size in weights.lock. The build fetches them and refuses a
mismatch (`fetch-weights`); the service checks them again before it loads them (`verify`).
`record` prints a lock from the files in the local Hugging Face cache (B2 Step 7 runs it, or
`verify`, in the image the owner tested). `wheels` turns pip's installation report into one line
per wheel and, once wheels.sha256 lists any, refuses a build whose wheels differ.

Usage: python pins.py fetch-weights | verify | record [--lock PATH]
       python pins.py wheels REPORT.json [--expect wheels.sha256]
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = "canberkkkkkk/ema-lightning"
# The files EMA() loads (ema_lightning/api.py 1.1.2: ema.pt, decoder.pt; config.json is asked for
# and never read).
FILES = ("ema.pt", "decoder.pt")
HERE = Path(__file__).resolve().parent
LOCK = HERE / "weights.lock"
HEX64 = re.compile(r"[0-9a-f]{64}")


class PinError(Exception):
    """A pinned file is missing or differs (the message names the file, never a path's content)."""


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_lock(path=LOCK):
    with open(path, encoding="utf-8") as f:
        lock = json.load(f)
    if lock.get("repo") != REPO:
        raise PinError(f"weights.lock is not for {REPO}")
    files = lock.get("files")
    if not isinstance(files, dict) or sorted(files) != sorted(FILES):
        raise PinError(f"weights.lock must pin exactly {', '.join(FILES)}")
    for name, entry in files.items():
        if not HEX64.fullmatch(str(entry.get("sha256", ""))):
            raise PinError(f"weights.lock: {name} has no sha256")
        if not isinstance(entry.get("size"), int) or entry["size"] <= 0:
            raise PinError(f"weights.lock: {name} has no size")
    return lock


def locate(name):
    """The cached file EMA() would load for `name` (the main revision), or None. Offline, no write."""
    from huggingface_hub import try_to_load_from_cache

    found = try_to_load_from_cache(REPO, name)
    return Path(found) if isinstance(found, str) else None


def verify(lock, locate=locate):
    """Every pinned file is in the cache with its size and SHA-256; returns name -> sha256."""
    digests = {}
    for name, entry in sorted(lock["files"].items()):
        path = locate(name)
        if path is None or not path.is_file():
            raise PinError(f"{name}: not in the model cache")
        if path.stat().st_size != entry["size"]:
            raise PinError(f"{name}: size differs from weights.lock")
        digest = sha256_of(path)
        if digest != entry["sha256"]:
            raise PinError(f"{name}: sha256 differs from weights.lock")
        digests[name] = digest
    return digests


def fetch(lock):
    """Build time, with network: download what EMA() will load, then verify it."""
    from huggingface_hub import hf_hub_download

    for name in sorted(lock["files"]):
        hf_hub_download(REPO, name)
    return verify(lock)


def record(locate=locate):
    files = {}
    for name in FILES:
        path = locate(name)
        if path is None:
            raise PinError(f"{name}: not in the model cache")
        files[name] = {"sha256": sha256_of(path), "size": path.stat().st_size}
    return {"repo": REPO, "files": files}


def _canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def wheels(report):
    """`name==version sha256=<hex>` per installed distribution of a `pip install --report`, sorted."""
    lines = []
    for item in report.get("install", []):
        meta, info = item.get("metadata", {}), item.get("download_info", {})
        archive = info.get("archive_info", {})
        digest = archive.get("hashes", {}).get("sha256")
        if not digest and str(archive.get("hash", "")).startswith("sha256="):
            digest = archive["hash"].split("=", 1)[1]
        lines.append(f"{_canonical(meta['name'])}=={meta['version']} sha256={digest or '?'}")
    return sorted(lines)


def listed(text):
    return sorted(line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#"))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pins.py")
    parser.add_argument("action", choices=["fetch-weights", "verify", "record", "wheels"])
    parser.add_argument("report", nargs="?")
    parser.add_argument("--lock", default=str(LOCK))
    parser.add_argument("--expect")
    args = parser.parse_args(argv)
    try:
        if args.action == "record":
            print(json.dumps(record(), indent=2, sort_keys=True))
        elif args.action == "wheels":
            with open(args.report, encoding="utf-8") as f:
                got = wheels(json.load(f))
            want = listed(Path(args.expect).read_text(encoding="utf-8")) if args.expect else []
            if want and want != got:
                names = sorted({line.split("==")[0] for line in set(want) ^ set(got)})
                raise PinError("the installed wheels differ from wheels.sha256: " + ", ".join(names))
            print("# pip install --report of the speak image: one installed wheel per line")
            print("\n".join(got))
        else:
            lock = load_lock(args.lock)
            digests = fetch(lock) if args.action == "fetch-weights" else verify(lock)
            print("weights: ok (" + ", ".join(f"{n} {d[:12]}" for n, d in digests.items()) + ")")
    except PinError as e:
        print(f"pins: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
