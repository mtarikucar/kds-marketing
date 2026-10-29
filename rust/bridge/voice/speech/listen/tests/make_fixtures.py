"""Writes the listen tests' audio: each fixture's sentences in the speak service's voice (EMA Lightning
at 8 kHz, through the speak image's own respelling and normaliser), its pauses as line silence, a
faint line hiss (about -65 dBFS) and G.711 A-law, as NetGSM's line carries it. Run in the speak
image, from rust/bridge/voice:

  docker run --rm --network none -v "$PWD/speech/listen/tests:/tests" --entrypoint python \\
    jeeta-voice-speak:<tag> /tests/make_fixtures.py

It rewrites fixtures/<name>.alaw and fixtures/fixtures.json. Synthetic speech only: no person's
recording is ever a fixture."""
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, "/app")  # the speak image's service

import listen_audio  # noqa: E402

# A sentence, or a pause in milliseconds.
FIXTURES = {
    "yarin": ["Evet, yarın saat on dörtte geliyorum."],
    "pause": ["Merhaba, ben Ayşe.", 1200, "Perşembe günü uygun musunuz?"],
    "digits": ["Numaram sıfır beş yüz otuz iki.", 2000, "Dört yüz on iki, otuz üç, sıfır sekiz."],
    "names": ["Benim adım Selin Karaosmanoğlu.", 1500, "Ben Zeynep Kılıçarslan, randevum vardı.", 1500,
              "Siparişiniz Talas şubemize ulaştı."],
}
EDGE_MS = 200


def main():
    from jeeta_speak import build_mouth

    mouth = build_mouth()
    out = {}
    for n, (name, parts) in enumerate(sorted(FIXTURES.items())):
        pcm = [np.zeros(EDGE_MS * 8, dtype=np.int16)]
        for part in parts:
            if isinstance(part, int):
                pcm.append(np.zeros(part * 8, dtype=np.int16))
            else:
                pcm.append(np.frombuffer(b"".join(mouth.chunks(part)), dtype="<i2"))
        pcm.append(np.zeros(EDGE_MS * 8, dtype=np.int16))
        x = np.concatenate(pcm).astype(np.float64) + np.random.default_rng(n).normal(0, 18, sum(map(len, pcm)))
        line = listen_audio.alaw_encode(np.clip(np.rint(x), -32768, 32767).astype(np.int16))
        (listen_audio.FIXTURES / f"{name}.alaw").write_bytes(line)
        out[name] = {"parts": parts, "seconds": round(len(line) / 8000, 3)}
    note = (f"EMA Lightning (speak voice {mouth.voice_id}) at 8 kHz, line hiss, G.711 A-law; "
            "written by tests/make_fixtures.py")
    text = json.dumps({"note": note, "fixtures": out}, ensure_ascii=False, indent=1)
    (listen_audio.FIXTURES / "fixtures.json").write_text(text + "\n", encoding="utf-8", newline="\n")
    print("\n".join(f"{k}: {v['seconds']} s" for k, v in out.items()))


if __name__ == "__main__":
    main()
