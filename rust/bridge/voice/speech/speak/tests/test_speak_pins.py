"""The image's pins: the weights by SHA-256 (with a fake cache), the wheel record, the shipped lock."""
import hashlib
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pins  # noqa: E402


def cache(tmp_path, contents):
    paths = {}
    for name, data in contents.items():
        path = tmp_path / name
        path.write_bytes(data)
        paths[name] = path
    return lambda name: paths.get(name)


def lock_of(contents):
    return {
        "repo": pins.REPO,
        "files": {n: {"sha256": hashlib.sha256(d).hexdigest(), "size": len(d)} for n, d in contents.items()},
    }


WEIGHTS = {"ema.pt": b"acoustic", "decoder.pt": b"vocoder!"}


def test_the_pinned_weights_pass(tmp_path):
    digests = pins.verify(lock_of(WEIGHTS), cache(tmp_path, WEIGHTS))
    assert digests == {n: hashlib.sha256(d).hexdigest() for n, d in WEIGHTS.items()}


def test_a_changed_missing_or_resized_weight_is_refused(tmp_path):
    lock = lock_of(WEIGHTS)
    with pytest.raises(pins.PinError, match="ema.pt: sha256"):
        pins.verify(lock, cache(tmp_path, {**WEIGHTS, "ema.pt": b"acoustiK"}))
    with pytest.raises(pins.PinError, match="decoder.pt: not in"):
        pins.verify(lock, cache(tmp_path, {"ema.pt": WEIGHTS["ema.pt"]}))
    with pytest.raises(pins.PinError, match="ema.pt: size"):
        pins.verify(lock, cache(tmp_path, {**WEIGHTS, "ema.pt": b"acoustic+"}))


def test_record_writes_a_lock_that_verifies(tmp_path):
    located = cache(tmp_path, WEIGHTS)
    recorded = pins.record(located)
    assert recorded == lock_of(WEIGHTS)
    path = tmp_path / "weights.lock"
    path.write_text(json.dumps(recorded), encoding="utf-8")
    pins.verify(pins.load_lock(path), located)


def test_a_lock_without_both_digests_is_refused(tmp_path):
    good = lock_of(WEIGHTS)
    bad = [
        {**good, "repo": "someone/else"},
        {**good, "files": {"ema.pt": good["files"]["ema.pt"]}},
        {**good, "files": {**good["files"], "ema.pt": {"sha256": "abc", "size": 8}}},
        {**good, "files": {**good["files"], "ema.pt": {"sha256": "0" * 64, "size": 0}}},
    ]
    for lock in bad:
        path = tmp_path / "weights.lock"
        path.write_text(json.dumps(lock), encoding="utf-8")
        with pytest.raises(pins.PinError):
            pins.load_lock(path)


def test_the_shipped_lock_pins_both_files_emas_loader_reads():
    lock = pins.load_lock()
    assert sorted(lock["files"]) == ["decoder.pt", "ema.pt"]


REPORT = {
    "install": [
        {
            "metadata": {"name": "Ema_Lightning", "version": "1.1.2"},
            "download_info": {"url": "https://files/x.whl", "archive_info": {"hashes": {"sha256": "a" * 64}}},
        },
        {
            "metadata": {"name": "torch", "version": "2.15.0+cpu"},
            "download_info": {"url": "https://download/t.whl", "archive_info": {"hash": "sha256=" + "b" * 64}},
        },
        {"metadata": {"name": "local.thing", "version": "0.1"}, "download_info": {"url": "file:///x", "dir_info": {}}},
    ]
}


def test_the_wheel_record_is_one_sorted_line_per_install():
    assert pins.wheels(REPORT) == [
        "ema-lightning==1.1.2 sha256=" + "a" * 64,
        "local-thing==0.1 sha256=?",
        "torch==2.15.0+cpu sha256=" + "b" * 64,
    ]


def test_a_build_whose_wheels_differ_from_the_record_or_lack_a_hash_fails(tmp_path, capsys):
    known = {"install": REPORT["install"][:2]}
    first, second = tmp_path / "torch.json", tmp_path / "pypi.json"
    first.write_text(json.dumps({"install": known["install"][1:]}), encoding="utf-8")
    second.write_text(json.dumps({"install": known["install"][:1]}), encoding="utf-8")
    expect = tmp_path / "wheels.sha256"
    expect.write_text("# a comment\n" + "\n".join(pins.wheels(known)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(first), str(second), "--expect", str(expect)]) == 0
    assert capsys.readouterr().out.splitlines()[1:] == pins.wheels(known)
    expect.write_text("ema-lightning==1.1.2 sha256=" + "c" * 64 + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(first), str(second), "--expect", str(expect)]) == 1
    assert "ema-lightning" in capsys.readouterr().err
    expect.write_text("# nothing recorded\n", encoding="utf-8")
    assert pins.main(["wheels", str(first), str(second), "--expect", str(expect)]) == 1
    unknown = tmp_path / "unknown.json"
    unknown.write_text(json.dumps(REPORT), encoding="utf-8")
    expect.write_text("\n".join(pins.wheels(REPORT)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(unknown), "--expect", str(expect)]) == 1
    assert "without a known sha256" in capsys.readouterr().err


SPEAK = pathlib.Path(__file__).resolve().parents[1]


def test_the_shipped_locks_are_the_record_the_frozen_set_and_the_requirements():
    locked = pins.check_lock()
    assert locked["ema-lightning"][0] == "1.1.2" and locked["torch"][0].endswith("+cpu")
    torch, rest = pins.lock_files(pins.read_record((SPEAK / "wheels.sha256").read_text(encoding="utf-8"), "w"))
    assert (SPEAK / "torch.lock").read_text(encoding="utf-8") == torch
    assert (SPEAK / "requirements.lock").read_text(encoding="utf-8") == rest, "run `python pins.py lock`"


def copy_pins(tmp_path):
    tmp_path.mkdir(parents=True)
    for name in ("constraints.txt", "requirements.txt", "wheels.sha256", "torch.lock", "requirements.lock"):
        (tmp_path / name).write_text((SPEAK / name).read_text(encoding="utf-8"), encoding="utf-8")
    return tmp_path


def edit(path, old, new):
    text = path.read_text(encoding="utf-8")
    assert old in text, old
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def test_check_lock_refuses_every_drift(tmp_path):
    cases = [
        ("constraints.txt", "ema-lightning==1.1.2", "ema-lightning==1.1.3", "owner's choice"),
        ("constraints.txt", "antalia-mini==1.0.1", "Antalia_Mini==1.0.2", "owner's choice"),
        ("constraints.txt", "torch==2.15.0+cpu", "torch==2.15.0", "CPU build"),
        ("constraints.txt", "numpy==2.5.4", "numpy==2.5.3", "numpy==2.5.3"),
        ("constraints.txt", "zipp==4.1.2\n", "zipp==4.1.2\nleftpad==1.0\n", "leftpad"),
        ("requirements.txt", "websockets==17.3", "websockets==18.0", "websockets==18.0"),
        ("requirements.txt", "antalia-mini==1.0.1", "antalia-mini", "requirements.txt must pin antalia-mini"),
        ("requirements.txt", "huggingface-hub", "huggingface-hub\nrequests", "requests"),
        ("requirements.lock", "--hash=sha256:fbde69", "--hash=sha256:fbde70", "wheels.sha256"),
        ("requirements.lock", "pytest==8.4.2", "pytest==8.4.3", "wheels.sha256"),
        ("torch.lock", "torch==", "numpy==", "torch alone"),
    ]
    for n, (name, old, new, message) in enumerate(cases):
        folder = copy_pins(tmp_path / str(n))
        edit(folder / name, old, new)
        with pytest.raises(pins.PinError, match=message):
            pins.check_lock(folder)
    # A package beyond the frozen set and EXTRA, even locked and recorded alike, is refused.
    folder = copy_pins(tmp_path / "beyond")
    with (folder / "wheels.sha256").open("a", encoding="utf-8") as f:
        f.write("leftpad==1.0 sha256=" + "e" * 64 + "\n")
    with (folder / "requirements.lock").open("a", encoding="utf-8") as f:
        f.write("leftpad==1.0 --hash=sha256:" + "e" * 64 + "\n")
    with pytest.raises(pins.PinError, match="beyond constraints.txt"):
        pins.check_lock(folder)
    folder = copy_pins(tmp_path / "names")
    edit(folder / "constraints.txt", "ema-lightning==1.1.2", "EMA_Lightning==1.1.2")
    pins.check_lock(folder)  # names compare the way PyPI compares them
