"""Installing sound packs: from a remote index, a URL, a zip, or Mechvibes.

Only the standard library is used, so the daemon stays dependency-free beyond
numpy. Archive extraction is guarded against path traversal ("zip slip").
"""
import json
import pathlib
import shutil
import tempfile
import urllib.error
import urllib.request
import wave
import zipfile

import numpy as np

from .packs import USER_PACKS, RATE, CHANNELS, decode

USER_AGENT = "gnome-typer/0.1 (+https://github.com/dixonSolutions/gnome-typer)"
TIMEOUT = 30
MAX_BYTES = 200 * 1024 * 1024


def _fetch(url, timeout=TIMEOUT):
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError(f"refusing non-http url: {url}")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("download exceeds size limit")
    return data


def fetch_index(url):
    """Retrieve the remote pack catalogue."""
    payload = json.loads(_fetch(url).decode("utf-8"))
    packs = payload.get("packs", payload) if isinstance(payload, dict) else payload
    if not isinstance(packs, list):
        raise ValueError("index is not a list of packs")
    return packs


def _safe_extract(archive, dest):
    """Extract a zip, rejecting absolute paths, traversal and symlinks."""
    dest = dest.resolve()
    for member in archive.infolist():
        name = member.filename
        if name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts:
            raise ValueError(f"unsafe path in archive: {name}")
        target = (dest / name).resolve()
        if not str(target).startswith(str(dest) + "/") and target != dest:
            raise ValueError(f"archive escapes destination: {name}")
        if (member.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError(f"symlink in archive: {name}")
    archive.extractall(dest)


def _find_root(tree, marker):
    """A zip may nest the pack one directory deep; find the real root."""
    if (tree / marker).exists():
        return tree
    for candidate in sorted(tree.rglob(marker)):
        return candidate.parent
    return None


def install_zip(zip_path, pack_id=None, dest_root=None):
    """Install a gnome-typer pack (pack.json) or a Mechvibes pack (config.json)."""
    dest_root = pathlib.Path(dest_root or USER_PACKS)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        with zipfile.ZipFile(zip_path) as archive:
            _safe_extract(archive, tmp)

        root = _find_root(tmp, "pack.json")
        if root:
            manifest = json.loads((root / "pack.json").read_text())
            pack_id = pack_id or manifest.get("id") or root.name
            manifest["id"] = pack_id
            (root / "pack.json").write_text(json.dumps(manifest, indent=2) + "\n")
            return _place(root, dest_root / pack_id)

        root = _find_root(tmp, "config.json")
        if root:
            converted = convert_mechvibes(root, pack_id=pack_id)
            return _place(converted, dest_root / converted.name)

        raise ValueError("archive contains neither pack.json nor config.json")


def _place(src, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    return dest


def install_url(url, pack_id=None, dest_root=None):
    data = _fetch(url)
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        return install_zip(tmp.name, pack_id=pack_id, dest_root=dest_root)


def install_from_index(index_url, pack_id, dest_root=None):
    for entry in fetch_index(index_url):
        if entry.get("id") == pack_id:
            url = entry.get("url")
            if not url:
                raise ValueError(f"index entry '{pack_id}' has no url")
            return install_url(url, pack_id=pack_id, dest_root=dest_root)
    raise KeyError(f"pack '{pack_id}' not in index")


def _write_wav(path, stereo):
    stereo = np.clip(stereo, -1.0, 1.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(CHANNELS)
        fh.setsampwidth(2)
        fh.setframerate(RATE)
        fh.writeframes((stereo * 32767).astype("<i2").tobytes())


def convert_mechvibes(src, pack_id=None, out=None):
    """Convert a Mechvibes pack into gnome-typer's format.

    Mechvibes keycodes come from a different input stack than evdev, so rather
    than guess at a mapping we treat every distinct sample as a variant of the
    generic key-down sound. Packs stay varied and correct-sounding; only
    per-key assignment is lost, which the user can re-add in settings.
    """
    src = pathlib.Path(src)
    config = json.loads((src / "config.json").read_text())
    pack_id = pack_id or config.get("id") or src.name
    pack_id = "".join(c if c.isalnum() or c in "-_" else "-" for c in str(pack_id).lower())
    out = pathlib.Path(out or (src.parent / f"{pack_id}-converted"))
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    defines = config.get("defines") or {}
    variants = []

    if str(config.get("key_define_type", "single")).lower() == "multi":
        seen = set()
        for value in defines.values():
            if not value or value in seen:
                continue
            seen.add(value)
            audio = src / value
            if audio.exists():
                variants.append(decode(audio))
    else:
        sprite_name = config.get("sound") or config.get("sprite")
        sprite_path = src / sprite_name if sprite_name else None
        if not sprite_path or not sprite_path.exists():
            raise ValueError("mechvibes pack has no usable sprite file")
        sprite = decode(sprite_path)
        seen = set()
        for value in defines.values():
            if not isinstance(value, (list, tuple)) or len(value) < 2:
                continue
            start_ms, dur_ms = float(value[0]), float(value[1])
            key = (round(start_ms), round(dur_ms))
            if key in seen or dur_ms <= 0:
                continue
            seen.add(key)
            start = int(start_ms / 1000.0 * RATE)
            end = min(len(sprite), start + int(dur_ms / 1000.0 * RATE))
            if end - start > 32:
                variants.append(sprite[start:end].copy())

    if not variants:
        raise ValueError("no usable samples found in mechvibes pack")

    # Keep a manageable, varied subset rather than hundreds of near-duplicates.
    variants = variants[:24]
    names = []
    for i, samples in enumerate(variants):
        name = f"down{i + 1}.wav"
        _write_wav(out / name, samples)
        names.append(name)

    manifest = {
        "id": pack_id,
        "name": config.get("name", pack_id),
        "description": f"Imported from Mechvibes pack '{config.get('name', pack_id)}'.",
        "author": config.get("author", "unknown"),
        "format": 1,
        "imported_from": "mechvibes",
        "sounds": {"down": names},
        "key_map": {},
    }
    (out / "pack.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return out


def import_mechvibes(path, pack_id=None, dest_root=None):
    path = pathlib.Path(path)
    dest_root = pathlib.Path(dest_root or USER_PACKS)
    if path.is_file() and path.suffix.lower() == ".zip":
        return install_zip(path, pack_id=pack_id, dest_root=dest_root)
    converted = convert_mechvibes(path, pack_id=pack_id)
    return _place(converted, dest_root / converted.name)


def remove(pack_id, dest_root=None):
    target = pathlib.Path(dest_root or USER_PACKS) / pack_id
    if not target.is_dir():
        raise KeyError(f"'{pack_id}' is not an installed (user) pack")
    shutil.rmtree(target)
    return target
