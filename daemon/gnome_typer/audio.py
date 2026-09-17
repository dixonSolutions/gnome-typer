"""Low-latency mixing output.

The naive approach - piping PCM to `pw-cat` - sounds badly delayed because a
Linux pipe buffers 64 KiB by default. At 48 kHz stereo s16 that is 16384 frames,
i.e. ~341 ms of audio queued ahead of the speaker. Shrinking the pipe to a
single page (4 KiB / ~21 ms) and asking the sink for a small quantum brings
end-to-end latency into the ~25 ms range, which reads as instant.
"""
import fcntl
import shutil
import subprocess
import threading

import numpy as np

F_SETPIPE_SZ = 1031
F_GETPIPE_SZ = 1032

RATE = 48000
CHANNELS = 2
BLOCK = 128                # ~2.7 ms per mix block
PIPE_BYTES = 4096          # one page: ~21 ms of queued audio
MAX_VOICES = 48


class Mixer:
    """Sums active one-shot samples into a single continuous output stream."""

    def __init__(self, gain=0.9, latency="5ms", device=None, rate=RATE):
        self.gain = float(gain)
        self.rate = rate
        self._voices = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._proc = None
        self._latency = latency
        self._device = device
        self.backend = None

    # -- process plumbing -------------------------------------------------
    def _spawn(self):
        if shutil.which("pw-cat"):
            cmd = ["pw-cat", "-p", "--format", "s16", "--rate", str(self.rate),
                   "--channels", str(CHANNELS), "--raw", "--latency", self._latency]
            if self._device:
                cmd += ["--target", self._device]
            cmd.append("-")
            self.backend = "pipewire"
        elif shutil.which("pacat"):
            cmd = ["pacat", "--format=s16le", f"--rate={self.rate}",
                   f"--channels={CHANNELS}", "--latency-msec=20"]
            self.backend = "pulse"
        elif shutil.which("aplay"):
            cmd = ["aplay", "-q", "-f", "S16_LE", "-r", str(self.rate),
                   "-c", str(CHANNELS), "-t", "raw", "-"]
            self.backend = "alsa"
        else:
            raise RuntimeError("no audio backend found (need pw-cat, pacat or aplay)")

        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            fcntl.fcntl(proc.stdin.fileno(), F_SETPIPE_SZ, PIPE_BYTES)
        except OSError:
            pass    # not fatal, just means we keep the default latency
        return proc

    def pipe_latency_ms(self):
        if not self._proc:
            return None
        try:
            size = fcntl.fcntl(self._proc.stdin.fileno(), F_GETPIPE_SZ)
        except OSError:
            return None
        return size / (CHANNELS * 2) / self.rate * 1000.0

    # -- playback ---------------------------------------------------------
    def play(self, samples, gain=1.0, pan=0.0):
        """Queue a sample. `gain` scales it; `pan` is -1 (left) .. 1 (right)."""
        if samples is None or not len(samples):
            return
        with self._lock:
            if len(self._voices) >= MAX_VOICES:
                self._voices.pop(0)
            left = gain * min(1.0, 1.0 - pan)
            right = gain * min(1.0, 1.0 + pan)
            self._voices.append([samples, 0, np.float32(left), np.float32(right)])

    def _mix_block(self, out):
        out[:] = 0.0
        with self._lock:
            keep = []
            for voice in self._voices:
                samples, pos, left, right = voice
                chunk = samples[pos:pos + BLOCK]
                n = len(chunk)
                if n:
                    out[:n, 0] += chunk[:, 0] * left
                    out[:n, 1] += chunk[:, 1] * right
                    voice[1] = pos + n
                    if voice[1] < len(samples):
                        keep.append(voice)
            self._voices = keep

    def _run(self):
        block = np.zeros((BLOCK, CHANNELS), dtype=np.float32)
        scratch = np.empty((BLOCK, CHANNELS), dtype="<i2")
        while not self._stop.is_set():
            self._mix_block(block)
            block *= self.gain
            # Soft-clip instead of hard wrap so dense typing distorts gracefully.
            np.tanh(block, out=block)
            np.multiply(block, 32767.0, out=block)
            scratch[:] = block.astype("<i2")
            try:
                self._proc.stdin.write(scratch.tobytes())
                self._proc.stdin.flush()
            except (BrokenPipeError, ValueError, AttributeError):
                if self._stop.is_set():
                    return
                self._proc = self._spawn()    # sink vanished (device switch); retry

    def start(self):
        self._proc = self._spawn()
        self._thread = threading.Thread(target=self._run, name="mixer", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._proc:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            try:
                self._proc.terminate()
                self._proc.wait(timeout=2)
            except Exception:
                pass
