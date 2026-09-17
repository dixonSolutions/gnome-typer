"""gnome-typer daemon entry point."""
import argparse
import json
import signal
import sys
import threading
import time

from . import config, engine, packs, store
from .audio import Mixer

VERSION = "0.1.0"
DEFAULT_INDEX = "https://raw.githubusercontent.com/dixonSolutions/gnome-typer/main/packs/index.json"


def log(msg):
    print(f"gnome-typer: {msg}", file=sys.stderr, flush=True)


def cmd_list_packs(args):
    found = packs.discover()
    if not found:
        print("no packs found")
        return 1
    if args.json:
        print(json.dumps([
            {k: v for k, v in m.items() if k != "sounds"} for m in found.values()
        ], indent=2))
        return 0
    for pack_id, manifest in sorted(found.items()):
        counts = sum(len(v) if isinstance(v, list) else 1
                     for v in (manifest.get("sounds") or {}).values())
        print(f"  {pack_id:14s} {manifest.get('name', pack_id):18s} "
              f"{counts:3d} samples  {manifest.get('description', '')}")
    return 0


def cmd_list_devices(args):
    devices = engine.keyboard_devices()
    if not devices:
        print("no readable keyboard devices found.")
        print("you probably need to be in the 'input' group: sudo usermod -aG input $USER")
        return 1
    for node, name in devices:
        print(f"  {node:22s} {name}")
    return 0


def cmd_list_remote(args):
    try:
        entries = store.fetch_index(args.index_url)
    except Exception as exc:
        log(f"could not fetch index: {exc}")
        return 1
    if args.json:
        print(json.dumps(entries, indent=2))
        return 0
    installed = set(packs.discover())
    for entry in entries:
        mark = "*" if entry.get("id") in installed else " "
        print(f" {mark} {entry.get('id', '?'):14s} {entry.get('name', ''):18s} "
              f"{entry.get('description', '')}")
    if entries:
        print("\n  * = already installed")
    return 0


def cmd_install(args):
    target = args.install_pack
    try:
        if target.lower().startswith(("http://", "https://")):
            path = store.install_url(target)
        elif target.lower().endswith(".zip"):
            path = store.install_zip(target)
        else:
            path = store.install_from_index(args.index_url, target)
    except Exception as exc:
        log(f"install failed: {exc}")
        return 1
    print(f"installed {path.name} -> {path}")
    return 0


def cmd_import_mechvibes(args):
    try:
        path = store.import_mechvibes(args.import_mechvibes, pack_id=args.pack)
    except Exception as exc:
        log(f"import failed: {exc}")
        return 1
    print(f"imported {path.name} -> {path}")
    print("note: per-key assignment is not carried over; samples become key-down variants.")
    return 0


def cmd_remove(args):
    try:
        path = store.remove(args.remove_pack)
    except Exception as exc:
        log(f"remove failed: {exc}")
        return 1
    print(f"removed {path}")
    return 0


def run(args):
    cfg = config.load(args.config)
    if args.pack:
        cfg["pack"] = args.pack
    if args.volume is not None:
        cfg["volume"] = args.volume
    if args.no_keyup:
        cfg["key_up_sounds"] = False

    try:
        pack = packs.load(cfg["pack"])
    except KeyError as exc:
        log(str(exc))
        return 1
    if getattr(pack, "errors", None):
        for err in pack.errors:
            log(f"warning: {err}")

    devices = engine.keyboard_devices(cfg.get("devices"), cfg.get("exclude_devices"))
    if not devices:
        log("no readable keyboard devices; add yourself to the 'input' group")
        return 1

    mixer = Mixer(gain=1.0, latency=args.latency, device=args.device).start()
    eng = engine.Engine(mixer, pack, cfg)

    log(f"v{VERSION} pack={pack.id} devices={len(devices)} "
        f"backend={mixer.backend} buffer={mixer.pipe_latency_ms():.0f}ms")
    if args.verbose:
        for node, name in devices:
            log(f"  {node} ({name})")

    def reload(new_cfg):
        try:
            new_pack = pack if new_cfg["pack"] == pack.id else packs.load(new_cfg["pack"])
        except KeyError as exc:
            log(f"reload: {exc}")
            return
        eng.reconfigure(new_cfg, new_pack)
        log(f"reloaded (pack={new_cfg['pack']} volume={new_cfg['volume']})")

    watcher = config.Watcher(reload, args.config)
    watcher.start()

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    for node, name in devices:
        threading.Thread(target=engine.watch_device, args=(node, name, eng),
                         kwargs={"log": log if args.verbose else None},
                         daemon=True).start()

    try:
        while not stop.wait(0.5):
            pass
    finally:
        watcher.stop()
        mixer.stop()
        log("stopped")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="gnome-typer", description="Keyboard sounds for GNOME/Wayland")
    ap.add_argument("--version", action="version", version=f"gnome-typer {VERSION}")
    ap.add_argument("-c", "--config", default=None, help="config file path")
    ap.add_argument("-p", "--pack", help="sound pack id (overrides config)")
    ap.add_argument("-g", "--volume", type=float, help="0..1 (overrides config)")
    ap.add_argument("--no-keyup", action="store_true", help="only sound on press")
    ap.add_argument("--latency", default="5ms", help="sink latency request (default 5ms)")
    ap.add_argument("--device", help="audio target sink")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--list-packs", action="store_true")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--init", action="store_true", help="write a default config file and exit")
    ap.add_argument("--index-url", default=DEFAULT_INDEX, help="remote pack catalogue")
    ap.add_argument("--list-remote", action="store_true", help="list downloadable packs")
    ap.add_argument("--install-pack", metavar="ID|URL|ZIP", help="install a sound pack")
    ap.add_argument("--import-mechvibes", metavar="PATH", help="import a Mechvibes pack (dir or zip)")
    ap.add_argument("--remove-pack", metavar="ID", help="remove an installed user pack")
    ap.add_argument("--json", action="store_true", help="machine-readable output where supported")
    args = ap.parse_args(argv)

    if args.list_packs:
        return cmd_list_packs(args)
    if args.list_devices:
        return cmd_list_devices(args)
    if args.list_remote:
        return cmd_list_remote(args)
    if args.install_pack:
        return cmd_install(args)
    if args.import_mechvibes:
        return cmd_import_mechvibes(args)
    if args.remove_pack:
        return cmd_remove(args)
    if args.init:
        path = config.write_default(args.config)
        print(f"wrote {path}")
        return 0
    return run(args)
