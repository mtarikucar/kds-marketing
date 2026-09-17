"""One lazy subprocess; a timeout kills native inference instead of abandoning a thread."""

import asyncio
import json
import os
import sys


class InferenceError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class ProcessRunner:
    def __init__(self, settings, *, command=None):
        self.settings = settings
        self.command = command or (sys.executable, "-m", "local_ai.worker")
        self.process = None
        self.busy = False

    def environment(self):
        env = os.environ.copy()
        env.update({
            "LOCAL_AI_ALLOW_DOWNLOAD": "1" if self.settings.allow_download else "0",
            "LOCAL_AI_WHISPER_SIZE": self.settings.whisper_size,
            "LOCAL_AI_CACHE_DIR": self.settings.cache_dir,
            "HF_HUB_OFFLINE": "0" if self.settings.allow_download else "1",
            "TRANSFORMERS_OFFLINE": "0" if self.settings.allow_download else "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "HF_HUB_DISABLE_XET": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "NUMEXPR_NUM_THREADS": "1",
            "CUDA_VISIBLE_DEVICES": "",
            "PYTHONUNBUFFERED": "1",
        })
        env.pop("LOCAL_AI_TOKEN", None)
        return env

    async def run(self, action, payload):
        if self.busy:
            raise InferenceError(429, "Local inference is busy")
        self.busy = True
        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                if self.process is None:
                    self.process = await asyncio.create_subprocess_exec(
                        *self.command,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL,
                        env=self.environment(),
                        limit=256 * 1024,
                    )
                self.process.stdin.write(json.dumps({"action": action, "payload": payload}).encode() + b"\n")
                await self.process.stdin.drain()
                line = await self.process.stdout.readline()
                if not line:
                    raise InferenceError(503, "Inference worker stopped; check the container memory limit")
                response = json.loads(line)
                if "error" in response:
                    raise InferenceError(response["error"]["status"], response["error"]["detail"])
                return response["result"]
        except TimeoutError:
            await self.close()
            raise InferenceError(504, "Inference deadline exceeded; worker terminated") from None
        except asyncio.CancelledError:
            await self.close()
            raise
        except InferenceError:
            await self.close()
            raise
        except Exception:
            await self.close()
            raise InferenceError(503, "Inference worker unavailable") from None
        finally:
            self.busy = False

    async def close(self):
        process, self.process = self.process, None
        if process is not None:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
