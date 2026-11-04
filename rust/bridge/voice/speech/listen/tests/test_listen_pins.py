"""The listen image's pins: the models by URL, SHA-256 and size (with fake files and a fake network),
the wheel record and the shipped lock."""
import copy
import hashlib
import io
import json
import os
import pathlib
import sys
import zipfile

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import listen_pins as pins  # noqa: E402

LISTEN = pathlib.Path(__file__).resolve().parents[1]
REV = "0" * 40
WHEEL_URL = "https://files.pythonhosted.org/packages/aa/bb/silero_vad-6.2.3-py3-none-any.whl"


def contents():
    return {name: f"model {name}".encode() for name in sorted(pins.MODEL_FILES)}


def wheel_with(member, data):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(member, data)
        z.writestr("silero_vad/__init__.py", b"")
    return buf.getvalue()


def lock_of(files, wheel=None):
    entries = {}
    for name, data in files.items():
        entry = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        if name.startswith("silero-vad/"):
            entry.update(url=WHEEL_URL, member="silero_vad/data/silero_vad.onnx",
                         archive_sha256=hashlib.sha256(wheel).hexdigest())
        else:
            target, _, rest = name.partition("/")
            entry["url"] = pins.hf_url(f"someone/{target}", REV, rest)
        entries[name] = entry
    return {"files": entries}


def network(files):
    """A urlopen stand-in serving `files` (name -> bytes) at the lock's URLs, and the wheel."""
    vad = files["silero-vad/silero_vad.onnx"]
    wheel = wheel_with("silero_vad/data/silero_vad.onnx", vad)
    served = {pins.hf_url(f"someone/{n.partition('/')[0]}", REV, n.partition("/")[2]): d
              for n, d in files.items() if not n.startswith("silero-vad/")}
    served[WHEEL_URL] = wheel
    fetched = []

    def opener(request, timeout):
        fetched.append(request.full_url)
        return io.BytesIO(served[request.full_url])

    return opener, wheel, fetched


def write(dest, files):
    for name, data in files.items():
        path = dest / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def test_the_pinned_models_pass(tmp_path):
    files = contents()
    _, wheel, _ = network(files)
    write(tmp_path, files)
    digests = pins.verify(lock_of(files, wheel), tmp_path)
    assert digests == {n: hashlib.sha256(d).hexdigest() for n, d in files.items()}


def test_a_changed_missing_or_resized_model_is_refused(tmp_path):
    files = contents()
    _, wheel, _ = network(files)
    lock = lock_of(files, wheel)
    write(tmp_path, {**files, "seda-v0.1/tokens.txt": b"model seda-v0.1/tokens.tXt"})
    with pytest.raises(pins.PinError, match="tokens.txt: sha256"):
        pins.verify(lock, tmp_path)
    write(tmp_path, files)
    (tmp_path / "smart-turn" / "smart-turn-v3.2-cpu.onnx").unlink()
    with pytest.raises(pins.PinError, match="smart-turn-v3.2-cpu.onnx: not in"):
        pins.verify(lock, tmp_path)
    write(tmp_path, {**files, "seda-v0.1/lm/2gram.fst": files["seda-v0.1/lm/2gram.fst"] + b"!"})
    with pytest.raises(pins.PinError, match="2gram.fst: size"):
        pins.verify(lock, tmp_path)


def test_fetch_downloads_checks_and_writes_readable_files(tmp_path):
    files = contents()
    opener, wheel, fetched = network(files)
    lock = lock_of(files, wheel)
    pins.fetch(lock, tmp_path, opener)
    assert sorted(fetched) == sorted({e["url"] for e in lock["files"].values()}), "the wheel is fetched once"
    for name, data in files.items():
        path = tmp_path / name
        assert path.read_bytes() == data
        if os.name == "posix":
            assert path.stat().st_mode & 0o777 == 0o644, name
    assert not [p for p in tmp_path.rglob(".part-*")]


def test_fetch_refuses_a_download_a_wheel_or_a_member_that_differs(tmp_path):
    files = contents()
    opener, wheel, _ = network(files)
    lock = lock_of(files, wheel)
    bad = copy.deepcopy(lock)
    bad["files"]["seda-v0.1/encoder.int8.onnx"]["sha256"] = "f" * 64
    with pytest.raises(pins.PinError, match="encoder.int8.onnx: the download differs"):
        pins.fetch(bad, tmp_path / "a", opener)
    assert not (tmp_path / "a" / "seda-v0.1" / "encoder.int8.onnx").exists(), "nothing half-checked is left"
    assert not [p for p in tmp_path.rglob(".part-*")]
    bad = copy.deepcopy(lock)
    bad["files"]["silero-vad/silero_vad.onnx"]["archive_sha256"] = "f" * 64
    with pytest.raises(pins.PinError, match="the wheel's sha256"):
        pins.fetch(bad, tmp_path / "b", opener)
    bad = copy.deepcopy(lock)
    bad["files"]["silero-vad/silero_vad.onnx"]["sha256"] = "f" * 64
    with pytest.raises(pins.PinError, match="the wheel's member differs"):
        pins.fetch(bad, tmp_path / "c", opener)
    bad = copy.deepcopy(lock)
    bad["files"]["silero-vad/silero_vad.onnx"]["member"] = "silero_vad/data/other.onnx"
    with pytest.raises(pins.PinError, match="no such member"):
        pins.fetch(bad, tmp_path / "d", opener)


def test_a_lock_that_does_not_pin_every_model_by_a_fixed_url_is_refused(tmp_path):
    files = contents()
    _, wheel, _ = network(files)
    good = lock_of(files, wheel)
    encoder = "seda-v0.1/encoder.int8.onnx"

    def with_entry(**changes):
        lock = copy.deepcopy(good)
        lock["files"][encoder].update(changes)
        return lock

    missing = copy.deepcopy(good)
    del missing["files"][encoder]
    extra = copy.deepcopy(good)
    extra["files"]["seda-v0.1/extra.onnx"] = good["files"][encoder]
    unpinned = good["files"][encoder]["url"].replace(REV, "main")
    vad = "silero-vad/silero_vad.onnx"
    no_member = copy.deepcopy(good)
    del no_member["files"][vad]["member"]
    bad = [
        missing, extra,
        with_entry(url=good["files"][encoder]["url"].replace("https", "http")),
        with_entry(url=unpinned),
        with_entry(url="https://example.com/encoder.int8.onnx"),
        with_entry(url=good["files"][encoder]["url"] + "?download=1"),
        with_entry(sha256="abc"), with_entry(size=0), with_entry(size=True),
        with_entry(member="x"),
        no_member,
    ]
    for n, lock in enumerate(bad):
        path = tmp_path / f"{n}.lock"
        path.write_text(json.dumps(lock), encoding="utf-8")
        with pytest.raises(pins.PinError):
            pins.load_lock(path)
    path = tmp_path / "good.lock"
    path.write_text(json.dumps(good), encoding="utf-8")
    pins.load_lock(path)


def test_the_shipped_lock_pins_the_models_at_the_sources_revisions():
    lock = pins.load_lock()
    assert set(lock["files"]) == pins.MODEL_FILES
    for name, entry in lock["files"].items():
        target = name.partition("/")[0]
        source = pins.SOURCES[target]
        if "revision" in source:
            assert entry["url"] == pins.hf_url(source["repo"], source["revision"], name.partition("/")[2])
        else:
            assert entry["url"].endswith(f"silero_vad-{source['version']}-py3-none-any.whl")
            assert entry["member"] == source["members"][name.partition("/")[2]]


REPORT = {
    "install": [
        {"metadata": {"name": "Sherpa_Onnx", "version": "2.0.1"},
         "download_info": {"url": "https://files/x.whl", "archive_info": {"hashes": {"sha256": "a" * 64}}}},
        {"metadata": {"name": "soxr", "version": "1.1.0"},
         "download_info": {"url": "https://files/s.whl", "archive_info": {"hash": "sha256=" + "b" * 64}}},
        {"metadata": {"name": "local.thing", "version": "0.1"}, "download_info": {"url": "file:///x", "dir_info": {}}},
    ]
}


def test_the_wheel_record_is_one_sorted_line_per_install():
    assert pins.wheels(REPORT) == [
        "local-thing==0.1 sha256=?",
        "sherpa-onnx==2.0.1 sha256=" + "a" * 64,
        "soxr==1.1.0 sha256=" + "b" * 64,
    ]


def test_a_build_whose_wheels_differ_from_the_record_or_lack_a_hash_fails(tmp_path, capsys):
    known = {"install": REPORT["install"][:2]}
    report = tmp_path / "pypi.json"
    report.write_text(json.dumps(known), encoding="utf-8")
    expect = tmp_path / "wheels.sha256"
    expect.write_text("# a comment\n" + "\n".join(pins.wheels(known)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(report), "--expect", str(expect)]) == 0
    assert capsys.readouterr().out.splitlines()[1:] == pins.wheels(known)
    expect.write_text("sherpa-onnx==2.0.1 sha256=" + "c" * 64 + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(report), "--expect", str(expect)]) == 1
    assert "sherpa-onnx" in capsys.readouterr().err
    unknown = tmp_path / "unknown.json"
    unknown.write_text(json.dumps(REPORT), encoding="utf-8")
    expect.write_text("\n".join(pins.wheels(REPORT)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(unknown), "--expect", str(expect)]) == 1
    assert "without a known sha256" in capsys.readouterr().err


def test_the_shipped_lock_is_the_record_the_frozen_set_and_the_requirements():
    locked = pins.check_lock()
    assert locked["sherpa-onnx"][0] == "2.0.1" and locked["onnxruntime"][0] == "1.31.1"
    record = pins.read_record((LISTEN / "wheels.sha256").read_text(encoding="utf-8"), "w")
    assert (LISTEN / "requirements.lock").read_text(encoding="utf-8") == pins.lock_text(record), \
        "run `python listen_pins.py lock`"


def copy_pins(folder):
    folder.mkdir(parents=True)
    for name in ("constraints.txt", "requirements.txt", "wheels.sha256", "requirements.lock"):
        (folder / name).write_text((LISTEN / name).read_text(encoding="utf-8"), encoding="utf-8")
    return folder


def edit(path, old, new):
    text = path.read_text(encoding="utf-8")
    assert old in text, old
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def test_check_lock_refuses_every_drift(tmp_path):
    cases = [
        ("constraints.txt", "numpy==2.5.4", "numpy==2.5.3", "numpy==2.5.3"),
        ("constraints.txt", "websockets==17.3\n", "websockets==17.3\nleftpad==1.0\n", "leftpad"),
        ("constraints.txt", "pluggy==1.7.0\n", "", "pluggy"),
        ("requirements.txt", "websockets==17.3", "websockets==18.0", "websockets==18.0"),
        ("requirements.txt", "soxr==1.1.0", "soxr", "not a name==version"),
        ("requirements.txt", "pytest==8.4.2", "pytest==8.4.2\nrequests==2.0", "requests"),
        ("requirements.lock", "--hash=sha256:fbde69", "--hash=sha256:fbde70", "wheels.sha256"),
        ("requirements.lock", "pytest==8.4.2", "pytest==8.4.3", "wheels.sha256"),
        ("wheels.sha256", "soxr==1.1.0 sha256=", "soxr==1.1.1 sha256=", "wheels.sha256"),
    ]
    for n, (name, old, new, message) in enumerate(cases):
        folder = copy_pins(tmp_path / str(n))
        edit(folder / name, old, new)
        with pytest.raises(pins.PinError, match=message):
            pins.check_lock(folder)
    folder = copy_pins(tmp_path / "names")
    edit(folder / "constraints.txt", "sherpa_onnx==2.0.1", "Sherpa.ONNX==2.0.1")
    pins.check_lock(folder)  # names compare the way PyPI compares them


def test_a_download_larger_than_pinned_is_cut_off(tmp_path):
    files = contents()
    opener, wheel, _ = network(files)
    lock = lock_of(files, wheel)
    swollen = dict(files)
    name = "seda-v0.1/decoder.onnx"
    swollen[name] = files[name] + b"x" * (2 << 20)  # well past the pinned size, in more than one read
    big_opener, _, _ = network(swollen)
    with pytest.raises(pins.PinError, match="larger than"):
        pins.fetch(lock, tmp_path, big_opener)
    assert not (tmp_path / name).exists() and not [p for p in tmp_path.rglob(".part-*")]
    with pytest.raises(pins.PinError, match="larger than 10 bytes"):
        pins.download("https://x", io.BytesIO(), lambda request, timeout: io.BytesIO(b"y" * 11), limit=10)
    assert pins.MAX_DOWNLOAD == 64 << 20
