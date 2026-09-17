import asyncio
import importlib.util
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def runner_types():
    assert importlib.util.find_spec("local_ai") is not None, "killable inference worker is not implemented"
    from local_ai.process import InferenceError, ProcessRunner
    from local_ai.settings import Settings

    return ProcessRunner, InferenceError, Settings


@pytest.fixture
def command(tmp_path):
    worker = tmp_path / "worker.py"
    worker.write_text('''import json, os, sys, time
for line in sys.stdin:
    request = json.loads(line)
    action = request["action"]
    if action == "sleep":
        open(request["payload"]["pid_file"], "w").write(str(os.getpid()))
        time.sleep(10)
    if action == "crash":
        sys.exit(3)
    if action == "error":
        print(json.dumps({"error": {"status": 422, "detail": "invalid audio"}}), flush=True)
    else:
        print(json.dumps({"result": {"pid": os.getpid(), "threads": os.environ["OMP_NUM_THREADS"], "offline": os.environ["HF_HUB_OFFLINE"]}}), flush=True)
''')
    return (sys.executable, str(worker))


def test_worker_is_lazy_reused_and_shutdown_reaps_process(runner_types, command):
    ProcessRunner, _, Settings = runner_types

    async def scenario():
        runner = ProcessRunner(Settings(token="test-token-with-at-least-32-characters"), command=command)
        try:
            first = await runner.run("echo", {})
            second = await runner.run("echo", {})
            assert first == second
            assert first["threads"] == "1"
            assert first["offline"] == "1"
        finally:
            await runner.close()
        with pytest.raises(ProcessLookupError):
            os.kill(first["pid"], 0)

    asyncio.run(scenario())


def test_deadline_kills_worker_and_next_request_recovers(runner_types, command, tmp_path):
    ProcessRunner, InferenceError, Settings = runner_types

    async def scenario():
        runner = ProcessRunner(Settings(token="test-token-with-at-least-32-characters", timeout_seconds=0.25), command=command)
        pid_file = tmp_path / "pid"
        try:
            with pytest.raises(InferenceError) as error:
                await runner.run("sleep", {"pid_file": str(pid_file)})
            assert error.value.status == 504
            pid = int(pid_file.read_text())
            with pytest.raises(ProcessLookupError):
                os.kill(pid, 0)
            assert (await runner.run("echo", {}))["pid"] != pid
        finally:
            await runner.close()

    asyncio.run(scenario())


def test_cancellation_kills_worker_without_overlap(runner_types, command, tmp_path):
    ProcessRunner, InferenceError, Settings = runner_types

    async def scenario():
        runner = ProcessRunner(Settings(token="test-token-with-at-least-32-characters"), command=command)
        pid_file = tmp_path / "pid"
        task = asyncio.create_task(runner.run("sleep", {"pid_file": str(pid_file)}))
        try:
            async with asyncio.timeout(2):
                while not pid_file.exists():
                    await asyncio.sleep(0.01)
            with pytest.raises(InferenceError) as error:
                await runner.run("echo", {})
            assert error.value.status == 429
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            with pytest.raises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)
            assert (await runner.run("echo", {}))["pid"] != int(pid_file.read_text())
        finally:
            task.cancel()
            await runner.close()

    asyncio.run(scenario())


def test_worker_crash_and_typed_input_errors(runner_types, command):
    ProcessRunner, InferenceError, Settings = runner_types

    async def scenario():
        runner = ProcessRunner(Settings(token="test-token-with-at-least-32-characters"), command=command)
        try:
            with pytest.raises(InferenceError) as error:
                await runner.run("crash", {})
            assert error.value.status == 503
            with pytest.raises(InferenceError) as error:
                await runner.run("error", {})
            assert error.value.status == 422
            assert (await runner.run("echo", {}))["pid"] > 0
        finally:
            await runner.close()

    asyncio.run(scenario())
