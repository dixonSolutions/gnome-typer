"""Small, freely downloadable music21-built scores and local synthesis."""
import hashlib
import json
import math
import pathlib
import re
import urllib.request

import numpy as np


def validate(manifest):
    if not isinstance(manifest, dict) or manifest.get('kind') != 'tune':
        raise ValueError('not a tune score')
    if not re.fullmatch(r'tune-[a-z0-9-]{1,70}', manifest.get('id', '')):
        raise ValueError('invalid tune id')
    tempo = manifest.get('tempo')
    if not isinstance(tempo, (int, float)) or not 40 <= tempo <= 220:
        raise ValueError('tempo outside 40–220 BPM')
    notes = manifest.get('melody')
    if not isinstance(notes, list) or not 1 <= len(notes) <= 256:
        raise ValueError('a tune needs 1–256 events')
    pitched = False
    for note in notes:
        if not isinstance(note, dict):
            raise ValueError('invalid note')
        midi, beats = note.get('midi'), note.get('beats')
        if midi is not None and (type(midi) is not int or not 36 <= midi <= 96):
            raise ValueError('pitch outside supported range')
        if not isinstance(beats, (int, float)) or not math.isfinite(beats) or not .125 <= beats <= 4:
            raise ValueError('invalid note length')
        pitched |= midi is not None
    if not pitched:
        raise ValueError('a tune needs a pitched note')
    return manifest


def synthesize(midi, seconds, rate=48000):
    """Gentle, short bell notes, generated without recordings or soundfonts."""
    t = np.arange(int(rate * min(.45, max(.1, seconds))), dtype=np.float32) / rate
    frequency = 440 * 2 ** ((midi - 69) / 12)
    envelope = np.minimum(t / .008, 1) * np.exp(-7 * t)
    envelope *= np.minimum((len(t) / rate - t) / .025, 1)
    wave = (.24 * np.sin(2 * np.pi * frequency * t) +
            .055 * np.sin(2 * np.pi * frequency * 2 * t)) * envelope
    return np.ascontiguousarray(np.column_stack((wave, wave)), dtype=np.float32)


def events(manifest):
    validate(manifest)
    cache = {}
    result = []
    for note in manifest['melody']:
        duration = note['beats'] * 60 / manifest['tempo']
        key = (note['midi'], duration)
        if key not in cache:
            cache[key] = None if key[0] is None else synthesize(key[0], duration)
        result.append((cache[key], duration))
    return result


def catalogue():
    return json.loads(pathlib.Path(__file__).with_name('tune-catalogue.json').read_text())


def install(tune_id):
    from . import packs
    entry = next((e for e in catalogue() if e['id'] == tune_id), None)
    if entry is None:
        raise ValueError('unknown curated tune')
    with urllib.request.urlopen(entry['url'], timeout=20) as response:
        data = response.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError('download did not match the catalogue checksum')
    manifest = validate(json.loads(data))
    if manifest['id'] != tune_id or manifest.get('license') != 'CC0-1.0':
        raise ValueError('unexpected tune identity or license')
    target = packs.USER_PACKS / tune_id
    target.mkdir(parents=True, exist_ok=True)
    temporary = target / 'pack.json.tmp'
    temporary.write_bytes(data)
    temporary.replace(target / 'pack.json')
    return target
