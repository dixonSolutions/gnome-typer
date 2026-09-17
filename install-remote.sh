#!/usr/bin/env bash
#
# Install gnome-typer from a published release - no git, no clone, no sudo.
#
#     curl -fsSL https://github.com/dixonSolutions/gnome-typer/releases/latest/download/install-remote.sh | bash
#
# Options (pass them after `| bash -s --`, or when running the file directly):
#   --version vX.Y.Z.N   install a specific release instead of the latest
#   --enable             also start the service and enable the extension
#   --help
#
# The same three things can come from the environment: GNOME_TYPER_VERSION,
# GNOME_TYPER_REPO and GNOME_TYPER_BASE_URL (a mirror, or a local copy of the
# assets when testing this script before a release exists).
#
# Everything lands under $HOME. The tarball is checked against the SHA256SUMS
# published alongside it, so a truncated or substituted download stops here
# rather than halfway through install.sh.
set -euo pipefail

REPO="${GNOME_TYPER_REPO:-dixonSolutions/gnome-typer}"
VERSION="${GNOME_TYPER_VERSION:-latest}"
UUID="gnome-typer@dixonsolutions.github.io"
ENABLE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:?--version needs a release tag}"; shift 2 ;;
        --version=*) VERSION="${1#*=}"; shift ;;
        --enable) ENABLE=1; shift ;;
        -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

if [ -n "${GNOME_TYPER_BASE_URL:-}" ]; then
    # Escape hatch for a mirror, or for testing this script against a local
    # copy of the assets before a release exists.
    BASE="${GNOME_TYPER_BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
    BASE="https://github.com/${REPO}/releases/latest/download"
else
    BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi

missing=""
for cmd in curl tar python3 sha256sum glib-compile-schemas; do
    command -v "$cmd" >/dev/null 2>&1 || missing="${missing} ${cmd}"
done
if [ -n "$missing" ]; then
    echo "missing required command(s):${missing}" >&2
    echo "  Debian/Ubuntu: sudo apt install curl tar python3 libglib2.0-bin" >&2
    echo "  Fedora:        sudo dnf install curl tar python3 glib2" >&2
    exit 1
fi
python3 -c 'import numpy' >/dev/null 2>&1 || {
    echo "NOTE: python3 numpy is missing - the daemon needs it."
    echo "      Debian/Ubuntu: sudo apt install python3-numpy"
    echo "      Fedora:        sudo dnf install python3-numpy"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() {  # fetch <asset>
    curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/$1" "${BASE}/$1" && return 0
    echo "could not download ${BASE}/$1" >&2
    echo "  check https://github.com/${REPO}/releases for a published release," >&2
    echo "  or clone the repository and run ./install.sh instead." >&2
    exit 1
}

echo "fetching gnome-typer (${VERSION}) from ${BASE}"
fetch gnome-typer.tar.gz
fetch SHA256SUMS

# Check only the file we downloaded: SHA256SUMS covers every release asset,
# and `sha256sum -c` on the whole list would fail on the ones we skipped.
( cd "$WORK" && grep ' gnome-typer\.tar\.gz$' SHA256SUMS | sha256sum -c - ) \
    || { echo "checksum mismatch - refusing to install" >&2; exit 1; }

tar -xzf "$WORK/gnome-typer.tar.gz" -C "$WORK"
TREE="$(find "$WORK" -maxdepth 1 -type d -name 'gnome-typer-*' | head -1)"
[ -x "$TREE/install.sh" ] || { echo "release tarball has no install.sh" >&2; exit 1; }

echo
"$TREE/install.sh"

if [ "$ENABLE" -eq 1 ]; then
    echo
    systemctl --user enable --now gnome-typer.service || true
    # The unit is Type=simple, so systemctl reports success the moment it has
    # forked - a daemon that exits because it can read no keyboard still looks
    # like a clean start. Ask the unit, a moment later, instead.
    sleep 3
    if [ "$(systemctl --user is-active gnome-typer.service)" = "active" ]; then
        echo "  daemon running."
    else
        echo "  the daemon is not running. The usual cause is the input group:"
        echo "    sudo usermod -aG input \"$USER\"   # then log out and back in"
        echo
        journalctl --user -u gnome-typer.service -n 5 --no-pager 2>/dev/null | sed 's/^/    /'
    fi

    # `gnome-extensions enable` asks the running shell, and a shell that has
    # not rescanned its extensions directory answers "doesn't exist" - which on
    # Wayland is every freshly installed extension. Setting the key directly
    # means it is simply on after the next login.
    if ! gnome-extensions enable "$UUID" 2>/dev/null; then
        if command -v gsettings >/dev/null 2>&1; then
            python3 - "$UUID" <<'ENABLE_PY'
import ast, subprocess, sys
uuid = sys.argv[1]
key = ["gsettings", "get", "org.gnome.shell", "enabled-extensions"]
current = subprocess.run(key, capture_output=True, text=True).stdout.strip()
items = ast.literal_eval(current.replace("@as ", "")) if current else []
if uuid in items:
    sys.exit(0)
items.append(uuid)
value = "[" + ", ".join(f"'{i}'" for i in items) + "]"
subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", value], check=True)
ENABLE_PY
        fi
        echo "  the extension is enabled; it appears after the next login (Wayland)."
    fi
fi
