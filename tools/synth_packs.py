#!/usr/bin/env python3
"""Synthesize gnome-typer's built-in sound packs.

Everything here is generated from noise and sine bodies, so the shipped packs
carry no third-party audio licensing. A key sound is built from three layers:

  transient  a few ms of high-passed noise - the physical strike
  body       fast-decaying low sines - the case/plate resonance ("thock")
  grit       granular noise, amplitude-chopped at audio rate - the "crunch"

Filtering is done in the frequency domain (rfft -> gaussian mask -> irfft)
which is both faster and easier to tune than cascaded biquads.
"""
import argparse
import json
import pathlib
import wave

import numpy as np

RATE = 48000
rng = np.random.default_rng(20260917)


def band(sig, lo, hi, rate=RATE):
    """Gaussian band-pass in the frequency domain."""
    spec = np.fft.rfft(sig)
    freqs = np.fft.rfftfreq(len(sig), 1 / rate)
    centre = np.sqrt(max(lo, 1) * max(hi, 2))
    width = max(hi - lo, 1) / 2.0
    mask = np.exp(-0.5 * ((freqs - centre) / width) ** 2)
    mask[freqs < lo * 0.35] *= 0.05
    return np.fft.irfft(spec * mask, n=len(sig))


def env(n, attack, decay, rate=RATE):
    """Percussive envelope: near-instant attack, exponential decay."""
    t = np.arange(n) / rate
    a = np.clip(t / max(attack, 1e-5), 0, 1)
    return a * np.exp(-t / max(decay, 1e-5))


def grit(n, density, rate=RATE):
    """Granular noise - chopping noise into random grains makes it crunch."""
    noise = rng.normal(0, 1, n)
    grain = max(int(rate / density), 1)
    steps = rng.random(int(np.ceil(n / grain)) + 1) ** 2.2
    chop = np.repeat(steps, grain)[:n]
    return noise * chop


def key_sound(*, dur=0.085, transient=(2500, 9000), body=(180, 320),
              body_level=0.45, grit_level=0.0, grit_density=1800,
              decay=0.02, body_decay=0.035, seed_jitter=1.0):
    """Compose one keystroke."""
    n = int(RATE * dur)
    t = np.arange(n) / RATE

    strike = band(rng.normal(0, 1, n), *transient) * env(n, 0.0003, decay * seed_jitter)

    thock = np.zeros(n)
    for i, f in enumerate(np.linspace(body[0], body[1], 3)):
        f *= 1 + rng.normal(0, 0.03)
        thock += np.sin(2 * np.pi * f * t + rng.random() * 6.28) * (0.6 ** i)
    thock *= env(n, 0.0008, body_decay * seed_jitter) * body_level

    out = strike + thock
    if grit_level > 0:
        crunch = band(grit(n, grit_density), 900, 6500) * env(n, 0.0005, decay * 1.6)
        out += crunch * grit_level

    peak = np.max(np.abs(out))
    if peak > 0:
        out /= peak
    return (out * 0.85).astype(np.float32)


def bell(freq=2100, dur=0.9):
    """The typewriter carriage ding."""
    n = int(RATE * dur)
    t = np.arange(n) / RATE
    sig = np.zeros(n)
    for mult, level in ((1.0, 1.0), (2.76, 0.5), (5.4, 0.25), (8.9, 0.12)):
        sig += np.sin(2 * np.pi * freq * mult * t) * level * np.exp(-t / (0.35 / mult ** 0.5))
    sig += band(rng.normal(0, 1, n), 3000, 9000) * env(n, 0.0002, 0.004) * 0.6
    sig /= np.max(np.abs(sig))
    return (sig * 0.8).astype(np.float32)


def write_wav(path, mono, width=0.12):
    """Write a slightly stereo-widened 16-bit WAV."""
    delay = int(RATE * 0.00018)
    left = mono.copy()
    right = np.concatenate([np.zeros(delay, np.float32), mono[:-delay] if delay else mono])
    right = right[:len(mono)] * (1 - width) + mono * width
    stereo = np.column_stack([left, right])
    stereo = np.clip(stereo, -1, 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(2)
        fh.setsampwidth(2)
        fh.setframerate(RATE)
        fh.writeframes((stereo * 32767).astype("<i2").tobytes())


PACKS = {
    "crunch": {
        "name": "Crunch",
        "description": "Gritty, crunchy tactile switches with a granular bite.",
        "down": dict(dur=0.10, transient=(1800, 7000), body=(150, 300), body_level=0.5,
                     grit_level=0.85, grit_density=1500, decay=0.024, body_decay=0.04),
        "up":   dict(dur=0.055, transient=(2600, 9000), body=(260, 420), body_level=0.22,
                     grit_level=0.45, grit_density=2400, decay=0.012, body_decay=0.018),
    },
    "typewriter": {
        "name": "Typewriter",
        "description": "Mechanical typebar clack with a carriage bell on Return.",
        "down": dict(dur=0.12, transient=(2200, 8500), body=(120, 260), body_level=0.65,
                     grit_level=0.3, grit_density=900, decay=0.03, body_decay=0.055),
        "up":   dict(dur=0.05, transient=(3000, 9500), body=(300, 500), body_level=0.2,
                     grit_level=0.15, decay=0.01, body_decay=0.015),
        "bell": True,
    },
    "thock": {
        "name": "Thock",
        "description": "Deep, muted linear switches. Low and round.",
        "down": dict(dur=0.13, transient=(900, 3800), body=(90, 190), body_level=0.9,
                     grit_level=0.12, decay=0.03, body_decay=0.07),
        "up":   dict(dur=0.06, transient=(1200, 4200), body=(180, 300), body_level=0.35,
                     grit_level=0.06, decay=0.014, body_decay=0.022),
    },
    "click": {
        "name": "Click",
        "description": "Sharp, bright clicky switches. Lots of top end.",
        "down": dict(dur=0.07, transient=(3500, 12000), body=(260, 520), body_level=0.3,
                     grit_level=0.35, grit_density=3200, decay=0.014, body_decay=0.02),
        "up":   dict(dur=0.04, transient=(4000, 13000), body=(400, 700), body_level=0.15,
                     grit_level=0.2, grit_density=3600, decay=0.008, body_decay=0.012),
    },
}

VARIANTS = 6        # per event, so repeated keys never sound identical


def build(pack_id, spec, root):
    out = root / pack_id
    sounds = {"down": [], "up": []}

    for event in ("down", "up"):
        for i in range(VARIANTS):
            jitter = 1.0 + rng.normal(0, 0.14)
            params = dict(spec[event])
            params["seed_jitter"] = max(0.6, jitter)
            name = f"{event}{i + 1}.wav"
            write_wav(out / name, key_sound(**params))
            sounds[event].append(name)

    # Space and Enter get heavier, slightly detuned versions of the down sound.
    for special, scale in (("space", 1.35), ("enter", 1.2)):
        sounds[special] = []
        for i in range(3):
            params = dict(spec["down"])
            params["dur"] = params["dur"] * 1.15
            params["body"] = (params["body"][0] / scale, params["body"][1] / scale)
            params["body_level"] = params["body_level"] * 1.2
            params["seed_jitter"] = 1.0 + rng.normal(0, 0.1)
            name = f"{special}{i + 1}.wav"
            write_wav(out / name, key_sound(**params))
            sounds[special].append(name)

    key_map = {"KEY_SPACE": "space", "KEY_ENTER": "enter", "KEY_KPENTER": "enter"}
    if spec.get("bell"):
        write_wav(out / "bell.wav", bell())
        sounds["bell"] = ["bell.wav"]
        key_map["KEY_ENTER"] = "bell"
        key_map["KEY_KPENTER"] = "bell"

    manifest = {
        "id": pack_id,
        "name": spec["name"],
        "description": spec["description"],
        "author": "gnome-typer (synthesized)",
        "license": "CC0-1.0",
        "format": 1,
        "sounds": sounds,
        "key_map": key_map,
    }
    (out / "pack.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default=str(pathlib.Path(__file__).resolve().parent.parent / "packs"))
    ap.add_argument("packs", nargs="*", default=None)
    args = ap.parse_args()
    root = pathlib.Path(args.out)
    wanted = args.packs or list(PACKS)
    for pack_id in wanted:
        m = build(pack_id, PACKS[pack_id], root)
        total = sum(len(v) for v in m["sounds"].values())
        print(f"  {pack_id:12s} {total:3d} samples  {m['description']}")


if __name__ == "__main__":
    main()
