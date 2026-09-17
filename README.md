# gnome-typer

Mechanical keyboard, typewriter and crunch sounds for every key — built for
**GNOME on Wayland**, where the usual tools go silent.

Shell 48, 49 and 50. No sudo. No cloud. No telemetry.

---

## Why this exists

The existing options break on a modern GNOME/Wayland session, all for the
same underlying reason:

| Tool | Why it fails on Wayland |
| --- | --- |
| `daktilo` | its input layer (`rdev`) uses **X11 XRecord**, which only sees keys delivered to XWayland clients |
| `bucklespring` | the packaged build is **X11-only** (its `--device` flag selects an *audio* device, not an input one) |
| Typewriter Keyboard *(ext 4427)* | supports Shell **3.38–42** |
| Keyboard Sounds *(ext 9317)* | supports Shell **49** only |

gnome-typer reads key events from `/dev/input` directly. Wayland does not gate
that, and no GNOME version can break it — the extension is only the UI.

## Latency

The naive approach — piping PCM into `pw-cat` — sounds badly delayed, and it is
not the audio server's fault. A Linux pipe buffers **64 KiB** by default. At
48 kHz stereo 16-bit that is 16384 frames:

```
 65536 B buffered = 16384 frames = 341.3 ms
  4096 B buffered =  1024 frames =  21.3 ms
```

gnome-typer shrinks the pipe to a single page and asks the sink for a small
quantum, which puts end-to-end latency around **21 ms** instead of ~341 ms.

## How loudness works

Be clear about this: **a keyboard cannot tell you how hard you pressed.** evdev
reports only up, down and autorepeat — there is no pressure or velocity in the
protocol for an ordinary USB or PS/2 keyboard.

So loudness is derived from typing dynamics instead:

- **Rhythm** — fast bursts read as hard, deliberate single keys read as soft,
  smoothed so one stray pause doesn't drop a whole burst.
- **Humanise** — a small random variation per hit.
- **Variants** — six samples per event, chosen without immediate repeats.
- **Position** — each key is panned by where it sits on the board, so `A` is
  left, `Backspace` is right.

All of it is tunable, and `Dynamics → Range → 0` turns it off.

## Install

### From a release — no clone, no sudo

One command. It downloads the latest release, checks it against the published
`SHA256SUMS`, and installs the daemon, packs, systemd unit and extension under
`$HOME`:

```bash
curl -fsSL https://github.com/dixonSolutions/gnome-typer/releases/latest/download/install-remote.sh | bash
```

Have it start everything too, instead of printing the two commands to run:

```bash
curl -fsSL https://github.com/dixonSolutions/gnome-typer/releases/latest/download/install-remote.sh | bash -s -- --enable
```

Piping a script into a shell is a thing to do with your eyes open, so reading
it first is entirely reasonable — it is short:

```bash
curl -fsSL -O https://github.com/dixonSolutions/gnome-typer/releases/latest/download/install-remote.sh
less install-remote.sh
bash install-remote.sh            # --enable, or --version v0.1.0.7 to pin a build
```

### Just the extension blob

The shell extension is published as an ordinary extension zip, with its
GSettings schemas already compiled, so `gnome-extensions install` takes it
directly:

```bash
url=https://github.com/dixonSolutions/gnome-typer/releases/latest/download
curl -fL -o /tmp/gnome-typer.zip "$url/gnome-typer@dixonsolutions.github.io.shell-extension.zip"
gnome-extensions install --force /tmp/gnome-typer.zip
gnome-extensions enable gnome-typer@dixonsolutions.github.io
```

The extension is only the UI: on its own its toggle has nothing to talk to. To
add the daemon afterwards, run the installer above — it is happy to install
over an existing copy.

Verify any of the downloads against the release checksums:

```bash
curl -fsSL -O "$url/SHA256SUMS"
sha256sum -c SHA256SUMS --ignore-missing
```

### From a clone

```bash
git clone https://github.com/dixonSolutions/gnome-typer
cd gnome-typer
./install.sh

systemctl --user enable --now gnome-typer.service
gnome-extensions enable gnome-typer@dixonsolutions.github.io
```

### Either way

You must be in the `input` group to read key events:

```bash
sudo usermod -aG input "$USER"    # then log out and back in
```

On Wayland a new extension needs a session restart (log out and back in);
the daemon itself works immediately.

Uninstalling is `./uninstall.sh` from a clone, or the same script from the
release if you never cloned:

```bash
curl -fsSL "$url/uninstall.sh" | bash          # add -s -- --purge to drop packs and config too
```

## Built-in packs

| Pack | Character |
| --- | --- |
| `crunch` | gritty, crunchy tactile switches with a granular bite |
| `typewriter` | mechanical typebar clack, carriage bell on Return |
| `thock` | deep, muted linear switches |
| `click` | sharp, bright clicky switches |

All four are **synthesized from noise and sine bodies** by
`tools/synth_packs.py`, so they carry no third-party audio licensing (CC0).
Regenerate or tweak them:

```bash
python3 tools/synth_packs.py crunch
```

## More packs

```bash
gnome-typer --list-remote                     # browse the catalogue
gnome-typer --install-pack thock              # install by id
gnome-typer --install-pack https://…/x.zip    # or by URL
gnome-typer --import-mechvibes ~/Downloads/some-pack/
gnome-typer --remove-pack thock
```

Mechvibes packs import directly — see [`packs/README.md`](packs/README.md) for
the format and the one caveat about per-key mapping.

Archives are extracted with guards against absolute paths, `..` traversal and
symlinks, and non-HTTP URLs are refused.

## Per-key and combination sounds

In **Settings → Keys**, or directly in `~/.config/gnome-typer/config.json`:

```json
{
  "key_sounds": { "KEY_ENTER": "bell", "KEY_SPACE": "space" },
  "combos": [
    { "keys": ["KEY_LEFTCTRL", "KEY_S"], "sound": "bell" },
    { "keys": ["KEY_LEFTCTRL", "KEY_LEFTSHIFT", "KEY_S"], "sound": "click" }
  ]
}
```

Longer combinations win over shorter ones. The daemon watches this file and
reloads live — no restart.

## Command line

```bash
gnome-typer --list-packs          # what's installed
gnome-typer --list-devices        # which input devices are readable
gnome-typer -p crunch -g 0.8      # run with a pack and volume
gnome-typer --init                # write a default config
gnome-typer --no-keyup            # press sounds only
```

## Architecture

```
extension/   GNOME Shell UI (Quick Settings toggle, volume, packs, prefs)
    │        writes ~/.config/gnome-typer/config.json
    ▼
daemon/      reads /dev/input → engine → mixer → PipeWire
  engine.py    velocity, combos, per-key routing, stereo placement
  audio.py     the low-latency mixer
  packs.py     pack discovery, decoding, caching
  store.py     downloads, zip safety, Mechvibes conversion
```

The shell never does audio work, so nothing here can stall the compositor.
The daemon needs no PyGObject — config passes through a JSON file — so its only
dependency beyond the standard library is numpy.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

`tools/test-extension-enable.sh` goes further: it starts a real headless
gnome-shell on a private session bus and fails unless the extension reaches
ENABLED and its preferences window loads. That needs an installed copy, so run
`./install.sh` first.

## Releases

Every commit on `main` runs [`.github/workflows/release.yml`](.github/workflows/release.yml):
tests, then `tools/build-release.sh`, then a GitHub release tagged
`v<daemon version>.<build number>` — so `releases/latest/download/…` always
serves the current code, and the URLs in this README never need editing.

Build the exact same artifacts locally to compare against a release:

```bash
tools/build-release.sh dist    # extension zip, pack zips, tarball, SHA256SUMS
```

The build stamps the release version into `metadata.json` (`version`,
`version-name`) and into the daemon, so `gnome-typer --version` tells you which
build is installed. `[skip release]` in a commit message tests and builds `main`
without publishing.

## Troubleshooting

**No sound.** Check the daemon can see your keyboard:

```bash
gnome-typer --list-devices
journalctl --user -u gnome-typer -n 30
```

If the list is empty you are not in the `input` group.

**Using `keyd`?** keyd takes an exclusive grab on physical keyboards and
re-emits through its own virtual device. gnome-typer autodetects and reads that
virtual keyboard, so this works — but if you pin `devices` manually in the
config, point it at the keyd device, not the physical one.

## Licence

GPL-3.0-or-later. Bundled sound packs are CC0-1.0.
