# Sound packs

A pack is a directory with `pack.json` and audio files.

```json
{
  "id": "crunch",
  "name": "Crunch",
  "description": "Gritty, crunchy tactile switches.",
  "author": "you",
  "license": "CC0-1.0",
  "format": 1,
  "sounds": {
    "down":  ["down1.wav", "down2.wav"],
    "up":    ["up1.wav"],
    "space": ["space1.wav"],
    "bell":  ["bell.wav"]
  },
  "key_map": { "KEY_SPACE": "space", "KEY_ENTER": "bell" }
}
```

- `sounds` maps a **category** to its variants. Variants are chosen without
  immediate repeats, which is what stops fast typing sounding like a machine gun.
- `down` is the only required category; everything else falls back to it.
- `key_map` gives a key its own category by default. Users can override this
  per key in the extension's settings without editing the pack.
- Any format ffmpeg can read works. WAV is decoded natively and is fastest.

Install a local pack with:

```bash
gnome-typer --install-pack ./mypack.zip
```

## Mechvibes packs

Mechvibes packs import directly:

```bash
gnome-typer --import-mechvibes ~/Downloads/some-mechvibes-pack/
```

Mechvibes keycodes come from a different input stack than evdev, so rather than
guess at a mapping, every distinct sample becomes a `down` variant. The pack
sounds correct and varied; only per-key assignment is lost, and you can re-add
that in settings.
