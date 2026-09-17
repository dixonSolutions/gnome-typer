#!/usr/bin/env bash
#
# Build every release artifact from a clean copy of HEAD.
#
# CI and a local debugging run use this one script, so whatever a release
# contains can always be reproduced on the machine that has to debug it:
#
#     tools/build-release.sh dist        # same bytes CI publishes
#
# Artifacts (asset names are deliberately version-free, so that
# /releases/latest/download/<name> keeps working release after release):
#
#   gnome-typer@dixonsolutions.github.io.shell-extension.zip
#   gnome-typer.tar.gz          full source + install.sh
#   install-remote.sh           the one-liner installer
#   uninstall.sh                removes what it installed
#   <pack>.zip                  one per built-in pack, for --install-pack
#   SHA256SUMS
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ARG="${1:-$SRC/dist}"
mkdir -p "$OUT_ARG"
OUT="$(cd "$OUT_ARG" && pwd)"
UUID="gnome-typer@dixonsolutions.github.io"

say() { printf '  %s\n' "$*"; }

# ------------------------------------------------------------------ version
# One source of truth for the base version: the daemon. The build number makes
# each main-branch build distinct and monotonic.
BASE="$(sed -n 's/^VERSION = "\(.*\)"$/\1/p' "$SRC/daemon/gnome_typer/cli.py")"
[ -n "$BASE" ] || { echo "cannot read VERSION from daemon/gnome_typer/cli.py" >&2; exit 1; }
BUILD="${BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-0}}"
VERSION="${RELEASE_VERSION:-${BASE}.${BUILD}}"
# GNOME requires an integer for metadata.json's "version"; it must never go
# backwards, so the build number is exactly the right thing to put there.
EXT_VERSION="$BUILD"
[ "$EXT_VERSION" -gt 0 ] 2>/dev/null || EXT_VERSION=1

echo "building gnome-typer ${VERSION} (extension version ${EXT_VERSION})"

# -------------------------------------------------------------- clean copy
# git archive, not the working tree: a release must never carry a stray edit,
# a __pycache__ or a local config someone forgot about.
if ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
    echo "not a git repository: $SRC" >&2; exit 1
fi
if ! git -C "$SRC" diff --quiet HEAD 2>/dev/null; then
    say "NOTE: working tree differs from HEAD; building HEAD, not your edits."
fi

STAGE="$OUT/.stage"
rm -rf "$STAGE"
TREE="$STAGE/gnome-typer-$VERSION"
mkdir -p "$TREE"
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$TREE"

# ------------------------------------------------------------------ stamp
python3 - "$TREE/extension/metadata.json" "$EXT_VERSION" "$VERSION" <<'PY'
import json, sys
path, ext_version, name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
meta = json.load(open(path))
meta["version"] = ext_version
meta["version-name"] = name
open(path, "w").write(json.dumps(meta, indent=2) + "\n")
PY
sed -i "s/^VERSION = \".*\"$/VERSION = \"${VERSION}\"/" "$TREE/daemon/gnome_typer/cli.py"
grep -q "^VERSION = \"${VERSION}\"$" "$TREE/daemon/gnome_typer/cli.py" \
    || { echo "failed to stamp daemon version" >&2; exit 1; }

# ------------------------------------------------------------------- zip
# Written by hand rather than with zip(1): the runner has it, a GNOME laptop
# often does not, and fixed timestamps keep the artifact byte-reproducible.
zip_dir() {
    python3 - "$1" "$2" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            info = zipfile.ZipInfo(os.path.relpath(full, src), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (os.stat(full).st_mode & 0o7777) << 16
            with open(full, "rb") as fh:
                z.writestr(info, fh.read())
PY
}

# -------------------------------------------------------------- extension
EXT="$STAGE/extension/$UUID"
mkdir -p "$EXT/schemas"
cp "$TREE/extension/metadata.json" "$EXT/"
cp "$TREE"/extension/*.js "$EXT/"
[ -f "$TREE/extension/stylesheet.css" ] && cp "$TREE/extension/stylesheet.css" "$EXT/"
cp "$TREE"/extension/schemas/*.gschema.xml "$EXT/schemas/"
# Ship the schemas compiled: `gnome-extensions install` only unzips, it never
# runs glib-compile-schemas, so an uncompiled zip enables into a dead toggle.
glib-compile-schemas "$EXT/schemas/"
zip_dir "$EXT" "$OUT/${UUID}.shell-extension.zip"
say "extension   ${UUID}.shell-extension.zip"

# ------------------------------------------------------------------ packs
for pack in "$TREE"/packs/*/; do
    [ -f "${pack}pack.json" ] || continue
    id="$(basename "$pack")"
    zip_dir "${pack%/}" "$OUT/${id}.zip"
    say "pack        ${id}.zip"
done

# --------------------------------------------------------------- tarball
tar -czf "$OUT/gnome-typer.tar.gz" -C "$STAGE" "gnome-typer-$VERSION"
say "source      gnome-typer.tar.gz (gnome-typer-${VERSION}/)"

# ------------------------------------------------------------- installer
cp "$TREE/install-remote.sh" "$OUT/install-remote.sh"
cp "$TREE/uninstall.sh" "$OUT/uninstall.sh"
chmod +x "$OUT/install-remote.sh" "$OUT/uninstall.sh"
say "installer   install-remote.sh, uninstall.sh"

# ------------------------------------------------------------- checksums
rm -rf "$STAGE"
( cd "$OUT" && sha256sum ./*.zip ./*.tar.gz install-remote.sh uninstall.sh | sed 's| \./| |' > SHA256SUMS )
printf '%s\n' "$VERSION" > "$OUT/VERSION"

echo
sed 's/^/  /' "$OUT/SHA256SUMS"
echo
echo "built into $OUT"
