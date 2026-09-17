"""The input side: read evdev, decide what a keystroke should sound like."""
import os
import random
import struct
import threading

from . import keycodes

EV_KEY = 1
VALUE_UP, VALUE_DOWN, VALUE_REPEAT = 0, 1, 2

EVENT_FMT = "llHHi"
EVENT_SIZE = struct.calcsize(EVENT_FMT)

# Rough physical layout, used to pan each key in the stereo field.
_ROWS = (
    "1234567890-=",
    "QWERTYUIOP[]",
    "ASDFGHJKL;'",
    "ZXCVBNM,./",
)
_EDGE_PAN = {
    "KEY_ESC": -0.95, "KEY_TAB": -0.85, "KEY_CAPSLOCK": -0.85, "KEY_LEFTSHIFT": -0.9,
    "KEY_LEFTCTRL": -0.95, "KEY_LEFTALT": -0.6, "KEY_LEFTMETA": -0.75,
    "KEY_BACKSPACE": 0.9, "KEY_ENTER": 0.8, "KEY_RIGHTSHIFT": 0.9,
    "KEY_RIGHTCTRL": 0.95, "KEY_RIGHTALT": 0.6, "KEY_BACKSLASH": 0.85,
    "KEY_SPACE": 0.0,
}


def _pan_table():
    table = dict(_EDGE_PAN)
    for row_index, row in enumerate(_ROWS):
        for col, char in enumerate(row):
            code = keycodes.resolve(char)
            if code is None:
                continue
            name = keycodes.CODE_TO_NAME.get(code)
            if not name or name in table:
                continue
            # Later rows sit further left on a real board; nudge accordingly.
            x = (col + row_index * 0.5) / (len(row) + 1.5)
            table[name] = round((x - 0.5) * 2.0, 3)
    for name in list(keycodes.NAME_TO_CODE):
        if name.startswith("KEY_KP") or name.startswith("KEY_NUMLOCK"):
            table.setdefault(name, 0.85)
    return table


PAN = _pan_table()


def keyboard_devices(include=None, exclude=None):
    """Readable evdev nodes that announce themselves as keyboards."""
    if include:
        return [(node, "explicit") for node in include if os.access(node, os.R_OK)]
    found = []
    try:
        with open("/proc/bus/input/devices") as fh:
            blocks = fh.read().split("\n\n")
    except OSError:
        return found
    for block in blocks:
        if "kbd" not in block:
            continue
        name, node = "", None
        for line in block.splitlines():
            if line.startswith("N: Name="):
                name = line.split("=", 1)[1].strip('"')
            elif line.startswith("H: Handlers="):
                for handler in line.split("=", 1)[1].split():
                    if handler.startswith("event"):
                        node = "/dev/input/" + handler
        if not node or not os.access(node, os.R_OK):
            continue
        if exclude and (node in exclude or any(x.lower() in name.lower() for x in exclude)):
            continue
        found.append((node, name))
    return found


class Velocity:
    """Approximates strike force from typing dynamics.

    Real keyboards report no pressure - evdev gives only up/down - so loudness
    is derived from how fast you are typing plus a little humanising jitter.
    Fast bursts read as hard, deliberate single keys read as soft.
    """

    def __init__(self, cfg):
        self.update(cfg)
        self._last_press = None
        self._smoothed = 0.5

    def update(self, cfg):
        v = cfg.get("velocity", {})
        self.enabled = bool(v.get("enabled", True))
        self.amount = float(v.get("amount", 0.55))
        self.fast = float(v.get("fast_ms", 55)) / 1000.0
        self.slow = float(v.get("slow_ms", 420)) / 1000.0
        self.humanize = float(v.get("humanize", 0.12))
        self.release_ratio = float(v.get("release_ratio", 0.5))

    def strike(self, now):
        if not self.enabled:
            return 1.0
        gap = self.slow if self._last_press is None else now - self._last_press
        self._last_press = now
        span = max(self.slow - self.fast, 1e-6)
        raw = (self.slow - min(max(gap, self.fast), self.slow)) / span
        # Smooth so one stray pause does not drop a whole burst in volume.
        self._smoothed = 0.6 * raw + 0.4 * self._smoothed
        level = 1.0 - self.amount + self.amount * self._smoothed
        if self.humanize:
            level *= 1.0 + random.uniform(-self.humanize, self.humanize)
        return max(0.05, min(1.6, level))


class Engine:
    """Turns key events into mixer calls."""

    def __init__(self, mixer, pack, cfg):
        self.mixer = mixer
        self.pack = pack
        self.cfg = cfg
        self.velocity = Velocity(cfg)
        self.held = set()
        self._cursors = {}
        self._lock = threading.Lock()
        self._compile()

    # -- configuration ----------------------------------------------------
    def _compile(self):
        self.key_sounds = {}
        for key, category in (self.cfg.get("key_sounds") or {}).items():
            code = keycodes.resolve(key)
            if code is not None:
                self.key_sounds[code] = category
        for key, category in (self.pack.key_map or {}).items():
            code = keycodes.resolve(key)
            if code is not None:
                self.key_sounds.setdefault(code, category)

        self.combos = []
        for combo in (self.cfg.get("combos") or []):
            codes = {keycodes.resolve(k) for k in combo.get("keys", [])}
            if None in codes or not codes:
                continue
            self.combos.append((codes, combo.get("sound"), combo.get("gain", 1.0)))
        # Longest combos first so Ctrl+Shift+S beats Ctrl+S.
        self.combos.sort(key=lambda c: -len(c[0]))

        self.enabled = bool(self.cfg.get("enabled", True))
        self.stereo = float(self.cfg.get("stereo", 0.35))
        self.volume = float(self.cfg.get("volume", 0.9))
        self.key_up = bool(self.cfg.get("key_up_sounds", True))
        self.repeats = bool(self.cfg.get("repeat_sounds", False))

    def reconfigure(self, cfg, pack=None):
        with self._lock:
            self.cfg = cfg
            if pack is not None:
                self.pack = pack
            self.velocity.update(cfg)
            self._compile()
            self.mixer.gain = 1.0        # per-voice gain carries the volume

    # -- sound selection --------------------------------------------------
    def _variant(self, category):
        """Round-robin through a category's variants, avoiding repeats."""
        variants = self.pack.sounds.get(category)
        if not variants:
            return None
        if len(variants) == 1:
            return variants[0]
        index = self._cursors.get(category, random.randrange(len(variants)))
        index = (index + random.randint(1, max(1, len(variants) - 1))) % len(variants)
        self._cursors[category] = index
        return variants[index]

    def _combo_category(self, code):
        if not self.combos:
            return None
        active = self.held | {code}
        for codes, sound, gain in self.combos:
            if code in codes and codes <= active and self.pack.has(sound):
                return sound, gain
        return None

    def on_key(self, code, value, now):
        if value == VALUE_DOWN:
            self.held.add(code)
        elif value == VALUE_UP:
            self.held.discard(code)

        # Muting still tracks held keys, so combos stay correct when re-enabled.
        if not self.enabled:
            return
        if value == VALUE_REPEAT and not self.repeats:
            return
        if value == VALUE_UP and not self.key_up:
            return

        name = keycodes.CODE_TO_NAME.get(code, "")
        pan = PAN.get(name, 0.0) * self.stereo

        if value in (VALUE_DOWN, VALUE_REPEAT):
            level = self.velocity.strike(now)
            hit = self._combo_category(code)
            if hit:
                category, extra = hit
            else:
                category, extra = self.key_sounds.get(code, "down"), 1.0
            if not self.pack.has(category):
                category = "down"
            if value == VALUE_REPEAT:
                extra *= 0.75
            self.mixer.play(self._variant(category), gain=self.volume * level * extra, pan=pan)
        else:
            category = "up" if self.pack.has("up") else None
            if category:
                level = self.velocity.release_ratio
                self.mixer.play(self._variant(category), gain=self.volume * level, pan=pan)


def watch_device(node, name, engine, log=None):
    """Read one device forever, feeding events to the engine."""
    import time
    try:
        fh = open(node, "rb", buffering=0)
    except OSError as exc:
        if log:
            log(f"skip {node} ({name}): {exc}")
        return
    if log:
        log(f"listening {node} ({name})")
    while True:
        try:
            data = fh.read(EVENT_SIZE)
        except OSError:
            return
        if not data or len(data) < EVENT_SIZE:
            return
        _, _, etype, code, value = struct.unpack(EVENT_FMT, data)
        if etype == EV_KEY:
            engine.on_key(code, value, time.monotonic())
