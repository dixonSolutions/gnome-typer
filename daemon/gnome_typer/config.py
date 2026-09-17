"""Configuration: a JSON file that both the daemon and the GNOME extension write.

Using a plain file rather than GSettings keeps the daemon free of any PyGObject
dependency; the extension mirrors its GSettings into this file on change. The
daemon watches the file's mtime and hot-reloads, so changes apply live.
"""
import copy
import json
import os
import pathlib
import threading
import time

CONFIG_DIR = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config")) / "gnome-typer"
CONFIG_PATH = CONFIG_DIR / "config.json"

DEFAULTS = {
    "enabled": True,
    "pack": "crunch",
    "volume": 0.9,
    "key_up_sounds": True,
    "repeat_sounds": False,          # sound on held-key autorepeat
    "stereo": 0.35,                  # pan by physical key position, 0 disables
    "velocity": {
        "enabled": True,
        "amount": 0.55,              # how much of the range dynamics can swing
        "fast_ms": 55,               # at/below this gap between keys -> loudest
        "slow_ms": 420,              # at/above this gap -> softest
        "humanize": 0.12,            # random per-hit variation
        "release_ratio": 0.5,        # key-up loudness relative to key-down
    },
    "key_sounds": {},                # {"KEY_ENTER": "bell"} - per-key category
    "combos": [],                    # [{"keys": ["KEY_LEFTCTRL","KEY_S"], "sound": "bell"}]
    "devices": [],                   # explicit /dev/input/eventN; empty = autodetect
    "exclude_devices": [],
}


def merge(base, override):
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def load(path=None):
    path = pathlib.Path(path or CONFIG_PATH)
    if not path.exists():
        return copy.deepcopy(DEFAULTS)
    try:
        return merge(DEFAULTS, json.loads(path.read_text()))
    except (OSError, json.JSONDecodeError):
        return copy.deepcopy(DEFAULTS)


def save(cfg, path=None):
    path = pathlib.Path(path or CONFIG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    tmp.replace(path)                # atomic, so a half-written file is never read


def write_default(path=None):
    path = pathlib.Path(path or CONFIG_PATH)
    if not path.exists():
        save(copy.deepcopy(DEFAULTS), path)
    return path


class Watcher(threading.Thread):
    """Poll the config file's mtime and fire `on_change(cfg)` when it moves."""

    def __init__(self, on_change, path=None, interval=0.5):
        super().__init__(name="config-watch", daemon=True)
        self.path = pathlib.Path(path or CONFIG_PATH)
        self.on_change = on_change
        self.interval = interval
        self._stop = threading.Event()
        self._stamp = self._mtime()

    def _mtime(self):
        try:
            return self.path.stat().st_mtime_ns
        except OSError:
            return 0

    def run(self):
        while not self._stop.wait(self.interval):
            stamp = self._mtime()
            if stamp != self._stamp:
                self._stamp = stamp
                time.sleep(0.05)      # let a writer finish
                try:
                    self.on_change(load(self.path))
                except Exception:
                    pass

    def stop(self):
        self._stop.set()
