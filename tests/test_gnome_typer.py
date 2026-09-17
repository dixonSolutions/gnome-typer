"""Unit tests for gnome-typer. Run: python3 -m unittest discover -s tests -v"""
import json
import pathlib
import sys
import tempfile
import unittest
import wave
import zipfile

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "daemon"))

from gnome_typer import config, engine, keycodes, packs, store   # noqa: E402

RATE = 48000


def write_wav(path, seconds=0.5, freq=440):
    t = np.arange(int(RATE * seconds)) / RATE
    mono = np.sin(2 * np.pi * freq * t) * 0.5
    stereo = np.column_stack([mono, mono])
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(2)
        fh.setsampwidth(2)
        fh.setframerate(RATE)
        fh.writeframes((stereo * 32767).astype("<i2").tobytes())


class TestKeycodes(unittest.TestCase):
    def test_resolve_forms(self):
        self.assertEqual(keycodes.resolve("a"), 30)
        self.assertEqual(keycodes.resolve("KEY_A"), 30)
        self.assertEqual(keycodes.resolve("A"), 30)
        self.assertEqual(keycodes.resolve(30), 30)
        self.assertEqual(keycodes.resolve("30"), 30)
        self.assertIsNone(keycodes.resolve("not_a_key"))

    def test_round_trip(self):
        for name in ("KEY_ENTER", "KEY_SPACE", "KEY_LEFTCTRL", "KEY_BACKSPACE"):
            self.assertEqual(keycodes.CODE_TO_NAME[keycodes.resolve(name)], name)


class TestConfig(unittest.TestCase):
    def test_merge_preserves_siblings(self):
        merged = config.merge(config.DEFAULTS, {"velocity": {"amount": 0.9}})
        self.assertEqual(merged["velocity"]["amount"], 0.9)
        self.assertEqual(merged["velocity"]["fast_ms"], config.DEFAULTS["velocity"]["fast_ms"])

    def test_bad_json_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = pathlib.Path(tmp) / "config.json"
            bad.write_text("{not json")
            self.assertEqual(config.load(bad)["pack"], config.DEFAULTS["pack"])

    def test_save_is_atomic_and_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "c.json"
            cfg = config.merge(config.DEFAULTS, {"volume": 0.25})
            config.save(cfg, path)
            self.assertEqual(config.load(path)["volume"], 0.25)
            self.assertFalse(path.with_suffix(".json.tmp").exists())


class TestVelocity(unittest.TestCase):
    def _velocity(self, **over):
        cfg = {"velocity": dict(config.DEFAULTS["velocity"], humanize=0.0, **over)}
        return engine.Velocity(cfg)

    def test_fast_is_louder_than_slow(self):
        fast = self._velocity()
        for i in range(6):
            loud = fast.strike(i * 0.05)
        slow = self._velocity()
        for i in range(6):
            quiet = slow.strike(i * 0.5)
        self.assertGreater(loud, quiet)

    def test_disabled_is_flat(self):
        v = self._velocity(enabled=False)
        self.assertEqual(v.strike(0.0), 1.0)
        self.assertEqual(v.strike(9.0), 1.0)

    def test_stays_in_range(self):
        v = self._velocity()
        for i in range(200):
            self.assertGreaterEqual(v.strike(i * 0.01), 0.05)
            self.assertLessEqual(v.strike(i * 0.01), 1.6)


class FakeMixer:
    def __init__(self):
        self.calls = []
        self.gain = 1.0

    def play(self, samples, gain=1.0, pan=0.0):
        self.calls.append({"samples": samples, "gain": gain, "pan": pan})


class FakePack:
    id = "fake"
    key_map = {}

    def __init__(self, categories=("down", "up", "bell")):
        self.sounds = {c: [np.zeros((4, 2), np.float32)] for c in categories}

    def has(self, category):
        return category in self.sounds


class TestEngine(unittest.TestCase):
    def _engine(self, **over):
        cfg = config.merge(config.DEFAULTS, over)
        mixer = FakeMixer()
        return engine.Engine(mixer, FakePack(), cfg), mixer

    def test_every_key_makes_a_sound(self):
        eng, mixer = self._engine()
        for code in (30, 29, 42, 57, 1, 125):     # a, ctrl, shift, space, esc, meta
            eng.on_key(code, engine.VALUE_DOWN, 0.0)
        self.assertEqual(len(mixer.calls), 6)

    def test_key_up_can_be_disabled(self):
        eng, mixer = self._engine(key_up_sounds=False)
        eng.on_key(30, engine.VALUE_DOWN, 0.0)
        eng.on_key(30, engine.VALUE_UP, 0.1)
        self.assertEqual(len(mixer.calls), 1)

    def test_autorepeat_off_by_default(self):
        eng, mixer = self._engine()
        eng.on_key(30, engine.VALUE_REPEAT, 0.0)
        self.assertEqual(mixer.calls, [])

    def test_combo_wins_over_plain_key(self):
        eng, mixer = self._engine(combos=[{"keys": ["KEY_LEFTCTRL", "KEY_S"], "sound": "bell"}])
        eng.on_key(29, engine.VALUE_DOWN, 0.0)            # ctrl down
        eng.on_key(31, engine.VALUE_DOWN, 0.05)           # s down -> combo
        self.assertIs(mixer.calls[-1]["samples"], eng.pack.sounds["bell"][0])

    def test_longest_combo_wins(self):
        eng, _ = self._engine(combos=[
            {"keys": ["KEY_LEFTCTRL", "KEY_S"], "sound": "down"},
            {"keys": ["KEY_LEFTCTRL", "KEY_LEFTSHIFT", "KEY_S"], "sound": "bell"},
        ])
        self.assertEqual(len(eng.combos[0][0]), 3)

    def test_per_key_override(self):
        eng, mixer = self._engine(key_sounds={"KEY_ENTER": "bell"})
        eng.on_key(28, engine.VALUE_DOWN, 0.0)
        self.assertIs(mixer.calls[-1]["samples"], eng.pack.sounds["bell"][0])

    def test_unknown_category_falls_back_to_down(self):
        eng, mixer = self._engine(key_sounds={"KEY_ENTER": "nope"})
        eng.on_key(28, engine.VALUE_DOWN, 0.0)
        self.assertIs(mixer.calls[-1]["samples"], eng.pack.sounds["down"][0])

    def test_stereo_pan_follows_layout(self):
        eng, mixer = self._engine(stereo=1.0)
        eng.on_key(keycodes.resolve("a"), engine.VALUE_DOWN, 0.0)
        left = mixer.calls[-1]["pan"]
        eng.on_key(keycodes.resolve("KEY_BACKSPACE"), engine.VALUE_DOWN, 0.1)
        right = mixer.calls[-1]["pan"]
        self.assertLess(left, 0)
        self.assertGreater(right, 0)

    def test_volume_scales_output(self):
        eng, mixer = self._engine(volume=0.5, velocity={"enabled": False})
        eng.on_key(30, engine.VALUE_DOWN, 0.0)
        self.assertAlmostEqual(mixer.calls[-1]["gain"], 0.5, places=6)


class TestStoreSecurity(unittest.TestCase):
    def test_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            evil = tmp / "evil.zip"
            with zipfile.ZipFile(evil, "w") as z:
                z.writestr("../../../../tmp/pwned.txt", "nope")
            with self.assertRaises(ValueError):
                store.install_zip(evil, dest_root=tmp / "dest")

    def test_rejects_absolute_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            evil = tmp / "abs.zip"
            with zipfile.ZipFile(evil, "w") as z:
                z.writestr("/etc/pwned.txt", "nope")
            with self.assertRaises(ValueError):
                store.install_zip(evil, dest_root=tmp / "dest")

    def test_rejects_non_http_url(self):
        with self.assertRaises(ValueError):
            store._fetch("file:///etc/passwd")

    def test_rejects_archive_without_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            plain = tmp / "plain.zip"
            with zipfile.ZipFile(plain, "w") as z:
                z.writestr("readme.txt", "hello")
            with self.assertRaises(ValueError):
                store.install_zip(plain, dest_root=tmp / "dest")


class TestMechvibes(unittest.TestCase):
    def _sprite_pack(self, root):
        write_wav(root / "sound.wav", seconds=1.0)
        (root / "config.json").write_text(json.dumps({
            "id": "testvibes", "name": "Test Vibes", "key_define_type": "single",
            "sound": "sound.wav",
            "defines": {"1": [0, 100], "2": [100, 100], "3": [200, 100], "4": [200, 100]},
        }))

    def test_sprite_conversion_dedupes(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pathlib.Path(tmp) / "mv"
            src.mkdir()
            self._sprite_pack(src)
            out = store.convert_mechvibes(src)
            manifest = json.loads((out / "pack.json").read_text())
            # 4 defines, but two are identical slices -> 3 unique variants
            self.assertEqual(len(manifest["sounds"]["down"]), 3)
            self.assertEqual(manifest["id"], "testvibes")

    def test_multi_conversion(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pathlib.Path(tmp) / "mv"
            src.mkdir()
            for name in ("a.wav", "b.wav"):
                write_wav(src / name, seconds=0.2)
            (src / "config.json").write_text(json.dumps({
                "id": "multi", "name": "Multi", "key_define_type": "multi",
                "defines": {"1": "a.wav", "2": "b.wav", "3": "a.wav"},
            }))
            out = store.convert_mechvibes(src)
            manifest = json.loads((out / "pack.json").read_text())
            self.assertEqual(len(manifest["sounds"]["down"]), 2)

    def test_converted_pack_loads(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pathlib.Path(tmp) / "mv"
            src.mkdir()
            self._sprite_pack(src)
            out = store.convert_mechvibes(src)
            manifest = json.loads((out / "pack.json").read_text())
            manifest["path"] = str(out)
            pack = packs.Pack(manifest)
            self.assertTrue(pack.has("down"))
            self.assertGreater(len(pack.sounds["down"]), 0)


class TestBuiltinPacks(unittest.TestCase):
    def test_all_builtin_packs_load(self):
        root = pathlib.Path(__file__).resolve().parent.parent / "packs"
        found = [p for p in root.glob("*/pack.json")]
        self.assertGreaterEqual(len(found), 4)
        for manifest_path in found:
            manifest = json.loads(manifest_path.read_text())
            manifest["path"] = str(manifest_path.parent)
            pack = packs.Pack(manifest)
            self.assertIn("down", pack.sounds)
            for category, variants in pack.sounds.items():
                for samples in variants:
                    self.assertEqual(samples.shape[1], 2, f"{pack.id}/{category} not stereo")
                    self.assertTrue(np.all(np.abs(samples) <= 1.0), f"{pack.id}/{category} clips")


if __name__ == "__main__":
    unittest.main()
