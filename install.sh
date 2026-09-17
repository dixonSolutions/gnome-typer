#!/usr/bin/env bash
# Install gnome-typer: daemon, sound packs, systemd unit and GNOME extension.
set -euo pipefail

UUID="gnome-typer@dixonsolutions.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-typer"
BIN="${HOME}/.local/bin"
EXT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/${UUID}"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

say() { printf '  %s\n' "$*"; }

echo "installing gnome-typer"

# ---------------------------------------------------------------- daemon
say "daemon      -> ${DATA}/daemon"
mkdir -p "${DATA}/daemon" "${BIN}"
rm -rf "${DATA}/daemon/gnome_typer"
cp -r "${SRC}/daemon/gnome_typer" "${DATA}/daemon/"
cp "${SRC}/daemon/gnome-typer" "${DATA}/daemon/"
chmod +x "${DATA}/daemon/gnome-typer"
ln -sf "${DATA}/daemon/gnome-typer" "${BIN}/gnome-typer"

# ------------------------------------------------------------ sound packs
say "packs       -> ${DATA}/builtin"
mkdir -p "${DATA}/builtin"
for pack in "${SRC}"/packs/*/; do
    [ -f "${pack}pack.json" ] || continue
    rm -rf "${DATA}/builtin/$(basename "${pack}")"
    cp -r "${pack}" "${DATA}/builtin/"
done

# --------------------------------------------------------------- extension
say "extension   -> ${EXT}"
mkdir -p "${EXT}"
cp "${SRC}/extension/metadata.json" "${EXT}/"
# Copy every module, not a hand-maintained list: the extension imports helper
# modules (daemon.js) that are easy to forget here and fail only at load time.
for js in "${SRC}"/extension/*.js; do
    [ -e "${js}" ] && cp "${js}" "${EXT}/"
done
[ -f "${SRC}/extension/stylesheet.css" ] && cp "${SRC}/extension/stylesheet.css" "${EXT}/"
mkdir -p "${EXT}/schemas"
cp "${SRC}/extension/schemas/"*.gschema.xml "${EXT}/schemas/"
glib-compile-schemas "${EXT}/schemas/"

# ----------------------------------------------------------------- systemd
say "service     -> ${UNIT}/gnome-typer.service"
mkdir -p "${UNIT}" "${HOME}/.cache/gnome-typer"
sed "s|@BIN@|${DATA}/daemon/gnome-typer|" "${SRC}/gnome-typer.service.in" > "${UNIT}/gnome-typer.service"
systemctl --user daemon-reload

# ------------------------------------------------------------------ config
"${BIN}/gnome-typer" --init >/dev/null 2>&1 || true

echo
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx input; then
    echo "  NOTE: you are not in the 'input' group, so the daemon cannot read key events."
    echo "        sudo usermod -aG input \"$USER\"   # then log out and back in"
    echo
fi

echo "installed. next:"
echo "  systemctl --user enable --now gnome-typer.service"
echo "  gnome-extensions enable ${UUID}"
echo
echo "  on Wayland the extension needs a session restart (log out and back in)."
echo "  gnome-typer --list-packs      # see what is available"
