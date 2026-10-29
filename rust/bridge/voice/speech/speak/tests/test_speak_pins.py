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


def test_a_build_whose_wheels_differ_from_the_record_fails(tmp_path, capsys):
    report = tmp_path / "report.json"
    report.write_text(json.dumps(REPORT), encoding="utf-8")
    expect = tmp_path / "wheels.sha256"
    expect.write_text("# a comment\n" + "\n".join(pins.wheels(REPORT)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(report), "--expect", str(expect)]) == 0
    assert capsys.readouterr().out.splitlines()[1:] == pins.wheels(REPORT)
    expect.write_text("ema-lightning==1.1.2 sha256=" + "c" * 64 + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(report), "--expect", str(expect)]) == 1
    assert "ema-lightning" in capsys.readouterr().err
    expect.write_text("# nothing recorded yet\n", encoding="utf-8")
    assert pins.main(["wheels", str(report), "--expect", str(expect)]) == 0
    assert capsys.readouterr().out.splitlines()[1:] == pins.wheels(REPORT)
