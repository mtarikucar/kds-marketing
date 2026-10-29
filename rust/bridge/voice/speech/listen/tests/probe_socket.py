"""A call through a running listen service: one fixture (listen_audio) sent in 20 ms frames at real
time, then 2 s of line silence; prints each event's kind, positions and how long after the end of
speech it arrived, never a word. Run in the listen image against the live socket (B3 Step 8):

  docker run --rm --pull never --network none --user 1502:1501 \\
    --mount type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice \\
    --entrypoint python jeeta-voice-listen:<tag> tests/probe_socket.py pause

Exit 0 when every sentence of the fixture came back as a final."""
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import listen_audio  # noqa: E402


def main(name, socket_path):
    from websockets.sync.client import unix_connect

    sentences = sum(1 for p in listen_audio.manifest()["fixtures"][name]["parts"] if isinstance(p, str))
    pcm = listen_audio.fixture(name) + listen_audio.alaw_decode(listen_audio.alaw_encode([0] * 16000))
    finals = 0
    with unix_connect(socket_path, open_timeout=5) as ws:
        hello = json.loads(ws.recv(timeout=5))
        print(f"hello: listen {hello['listen_id']}")
        ws.send(json.dumps({"type": "start", "sample_rate": 8000, "hotwords": []}))
        started = time.monotonic()
        for n, i in enumerate(range(0, len(pcm), 320), start=1):
            ws.send(pcm[i:i + 320])
            while True:
                try:
                    m = json.loads(ws.recv(timeout=max(0.0, started + n * 0.02 - time.monotonic())))
                except TimeoutError:
                    break
                if m["type"] == "partial":
                    continue
                wall = int((time.monotonic() - started) * 1000)
                if m["type"] == "final":
                    finals += 1
                    print(f"final: by {m['endpoint_by']}, speech end {m['speech_end_ms']} ms, endpoint "
                          f"{m['endpoint_ms']} ms, stt {m['stt_ms']} ms, here {wall - m['speech_end_ms']} ms "
                          f"after the end of speech, {len(m['text'])} chars")
                else:
                    print(f"{m['type']}: " + ", ".join(f"{k} {v}" for k, v in m.items() if k != "type"))
    print(f"{finals}/{sentences} sentences final")
    return 0 if finals == sentences else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "pause",
                  os.environ.get("LISTEN_SOCKET", "unix:/run/jeeta-voice/listen/listen.sock").removeprefix("unix:")))
