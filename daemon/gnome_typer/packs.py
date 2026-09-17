"""Sound pack discovery, loading and decoding.

A pack is a directory containing pack.json plus audio files:

    {
      "id": "crunch",
      "name": "Crunch",
      "sounds": { "down": ["down1.wav", ...], "up": [...], "space": [...] },
      "key_map": { "KEY_SPACE": "space", "KEY_ENTER": "bell" }
    }

Any format ffmpeg understands works; WAV is decoded natively so the common
case needs no subprocess at all. Decoded PCM is cached as .npy next to a
fingerprint so repeat launches are instant.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import wave

import numpy as np

RATE = 48000
CHANNELS = 2

USER_PACKS = pathlib.Path(os.environ.get("XDG_DATA_HOME", pathlib.Path.home() / ".local/share")) / "gnome-typer/packs"
CACHE_DIR = pathlib.Path(os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache")) / "gnome-typer"


def search_paths():
    """User packs win over bundled ones, so a downloaded pack can shadow a builtin."""
    paths = [USER_PACKS, USER_PACKS.parent / "builtin"]
    env = os.environ.get("GNOME_TYPER_PACKS")
    if env:
        paths += [pathlib.Path(p) for p in env.split(os.pathsep) if p]
    paths.append(pathlib.Path(__file__).resolve().parent.parent.parent / "packs")
    paths.append(pathlib.Path("/usr/share/gnome-typer/packs"))
    return [p for p in paths if p.is_dir()]


def discover():
    """Return {pack_id: manifest} across every search path."""
    found = {}
    for root in search_paths():
        for manifest_path in sorted(root.glob("*/pack.json")):
            try:
                manifest = json.loads(manifest_path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            pack_id = manifest.get("id") or manifest_path.parent.name
            manifest["id"] = pack_id
            manifest["path"] = str(manifest_path.parent)
            found.setdefault(pack_id, manifest)
    return found


def _decode_wav(path):
    with wave.open(str(path), "rb") as fh:
        channels, width, rate = fh.getnchannels(), fh.getsampwidth(), fh.getframerate()
        raw = fh.readframes(fh.getnframes())
    if width != 2:
        return None                      # let ffmpeg handle exotic widths
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    data = data.reshape(-1, channels)
    if channels == 1:
        data = np.column_stack([data[:, 0], data[:, 0]])
    elif channels > 2:
        data = data[:, :2]
    if rate != RATE:
        idx = np.linspace(0, len(data) - 1, int(len(data) * RATE / rate))
        data = np.column_stack([np.interp(idx, np.arange(len(data)), data[:, c]) for c in range(2)])
    return np.ascontiguousarray(data, dtype=np.float32)


def _decode_ffmpeg(path):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le",
         "-ar", str(RATE), "-ac", str(CHANNELS), "-"],
        capture_output=True,
    )
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"decode failed: {path}: {out.stderr.decode().strip()[:200]}")
    return (np.frombuffer(out.stdout, dtype="<i2").reshape(-1, CHANNELS).astype(np.float32) / 32768.0)


def decode(path):
    """Decode one audio file to float32 stereo at RATE, with an on-disk cache."""
    path = pathlib.Path(path)
    stat = path.stat()
    key = hashlib.sha1(f"{path}:{stat.st_mtime_ns}:{stat.st_size}:{RATE}".encode()).hexdigest()[:20]
    cached = CACHE_DIR / f"{key}.npy"
    if cached.exists():
        try:
            return np.load(cached)
        except (OSError, ValueError):
            pass

    data = None
    if path.suffix.lower() == ".wav":
        try:
            data = _decode_wav(path)
        except (OSError, wave.Error):
            data = None
    if data is None:
        data = _decode_ffmpeg(path)

    data = np.ascontiguousarray(data, dtype=np.float32)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        np.save(cached, data)
    except OSError:
        pass
    return data


class Pack:
    """A loaded pack: named sound categories, each a list of variants."""

    def __init__(self, manifest):
        self.id = manifest["id"]
        self.name = manifest.get("name", self.id)
        self.description = manifest.get("description", "")
        self.path = pathlib.Path(manifest["path"])
        self.manifest = manifest
        self.sounds = {}
        self.key_map = dict(manifest.get("key_map") or {})
        self._load()

    def _load(self):
        if self.manifest.get("kind") == "tune":
            from .tunes import events
            self.tune_events = events(self.manifest)
            self.sounds["down"] = [sample for sample, _ in self.tune_events if sample is not None]
            self.key_map = {}
            self.errors = []
            return
        errors = []
        for category, files in (self.manifest.get("sounds") or {}).items():
            if isinstance(files, str):
                files = [files]
            variants = []
            for name in files:
                try:
                    variants.append(decode(self.path / name))
                except Exception as exc:
                    errors.append(f"{category}/{name}: {exc}")
            if variants:
                self.sounds[category] = variants
        if "down" not in self.sounds:
            raise RuntimeError(f"pack '{self.id}' has no 'down' sounds" +
                               (f" ({'; '.join(errors)})" if errors else ""))
        self.errors = errors

    def category_for(self, key_name):
        return self.key_map.get(key_name)

    def has(self, category):
        return category in self.sounds

    def __repr__(self):
        counts = ", ".join(f"{k}={len(v)}" for k, v in sorted(self.sounds.items()))
        return f"<Pack {self.id} ({counts})>"


def load(pack_id):
    packs = discover()
    if pack_id not in packs:
        raise KeyError(f"unknown pack '{pack_id}'; available: {', '.join(sorted(packs)) or 'none'}")
    return Pack(packs[pack_id])
