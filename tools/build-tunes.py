#!/usr/bin/env python3
"""Rebuild the CC0 tune catalogue with music21; no runtime music21 dependency.

New monophonic encodings of traditional/historical melodies plus original riffs.
No modern arrangement, recording, or restricted music21 corpus file is copied.
"""
import hashlib
import json
from pathlib import Path
from music21 import converter, metadata

ROOT = Path(__file__).resolve().parent.parent
BASE = 'https://raw.githubusercontent.com/evaRATrad/gnome-typer/improve/typing-experience/catalogue/tunes'
# title, composer/source, short description, notes (middle C = c), tempo, bundled
TUNES = [
 ('ode-to-joy', 'Ode to Joy', 'Ludwig van Beethoven (1824)', 'A cheerful, familiar opening phrase.', 'e4 e f g g f e d c c d e e4. d8 d2', 112, True),
 ('frere-jacques', 'Frère Jacques', 'Traditional French round', 'A playful round to type along with.', 'c4 d e c c d e c e f g2 e4 f g2 g8 a g f e4 c g8 a g f e4 c c G c2 c4 G c2', 112, True),
 ('pixel-parade', 'Pixel Parade', 'GNOME Typer · original', 'A bright little arcade-style loop.', 'c8 e g c\' g e d f a d\' a f e g b e\' d\' b g e c4 r4', 132, True),
 ('twinkle', 'Twinkle, Twinkle', 'Traditional · Ah! vous dirai-je, maman (1761)', 'A gentle and immediately recognisable melody.', 'c4 c g g a a g2 f4 f e e d d c2', 100, False),
 ('jingle-bells', 'Jingle Bells', 'James Lord Pierpont (1857)', 'A little festive typing cheer.', 'e4 e e2 e4 e e2 e4 g c d e1 f4 f f4. f8 f4 e e e8 e d4 d e d2 g2', 124, False),
 ('london-bridge', 'London Bridge', 'Traditional English nursery song', 'A bouncy familiar phrase.', 'g4. a8 g4 f e f g2 d4 e f2 e4 f g2 g4. a8 g4 f e f g2 d2 g4 e c1', 112, False),
 ('row-your-boat', 'Row Your Boat', 'Traditional round · 19th century', 'A soft, lilting melody.', 'c4. c4. c4 d8 e4. e4 d8 e4 f8 g2. c\'8 c\' c\' g g g e e e c c c g4 f8 e4 d8 c2.', 100, False),
 ('saints', 'When the Saints', 'Traditional spiritual', 'A sunny marching phrase.', 'c4 e f g2. c4 e f g2. c4 e f g2 e2 c4 e d2. e4 e d c2 c4 e g g f1', 118, False),
 ('gentle-orbit', 'Gentle Orbit', 'GNOME Typer · original', 'A calm pentatonic loop for a quieter desk.', 'c4 e g a2 g4 e d2 e4 g e d c2 r2', 84, False),
 ('victory-lap', 'Victory Lap', 'GNOME Typer · original', 'A tiny celebratory fanfare.', 'c8 c e4 g8 g c\'4 b8 a g e f4 d g8 e c2 r4', 128, False),
]

def main():
    directory = ROOT / 'catalogue/tunes'
    directory.mkdir(parents=True, exist_ok=True)
    index = []
    for slug, title, author, description, notation, bpm, bundled in TUNES:
        score = converter.parse('tinyNotation: 4/4 ' + notation)
        score.metadata = metadata.Metadata(title=title, composer=author)
        notes = [{'midi': None if n.isRest else int(n.pitch.midi), 'beats': float(n.quarterLength)}
                 for n in score.flatten().notesAndRests]
        manifest = {'format': 1, 'id': 'tune-' + slug, 'name': title, 'kind': 'tune',
                    'description': description, 'author': author, 'license': 'CC0-1.0',
                    'encoding_note': 'New monophonic encoding and synthesis; no third-party recording or modern arrangement.',
                    'source': f'{BASE}/{slug}.musicxml', 'built_with': 'music21',
                    'tempo': bpm, 'melody': notes}
        payload = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        (directory / f'{slug}.json').write_bytes(payload)
        score.write('musicxml', fp=directory / f'{slug}.musicxml')
        if bundled:
            destination = ROOT / 'packs' / manifest['id']
            destination.mkdir(exist_ok=True)
            (destination / 'pack.json').write_bytes(payload)
        index.append({k: manifest[k] for k in ['id', 'name', 'description', 'author', 'license', 'kind', 'source']}
                     | {'url': f'{BASE}/{slug}.json', 'sha256': hashlib.sha256(payload).hexdigest(), 'bundled': bundled})
    out = json.dumps(index, ensure_ascii=False, indent=2) + '\n'
    (ROOT / 'catalogue/index.json').write_text(out)
    (ROOT / 'daemon/gnome_typer/tune-catalogue.json').write_text(out)
    print(f'Built {len(index)} tunes with music21; {sum(t[-1] for t in TUNES)} bundled')

if __name__ == '__main__':
    main()
