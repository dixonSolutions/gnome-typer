#!/usr/bin/env bash
# Remove everything install.sh created. Downloaded packs are kept unless --purge.
set -euo pipefail

UUID="gnome-typer@dixonsolutions.github.io"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-typer"
EXT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/${UUID}"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/gnome-typer.service"

systemctl --user disable --now gnome-typer.service 2>/dev/null || true
gnome-extensions disable "${UUID}" 2>/dev/null || true

rm -f "${UNIT}" "${HOME}/.local/bin/gnome-typer"
rm -rf "${EXT}" "${DATA}/daemon" "${DATA}/builtin"
systemctl --user daemon-reload 2>/dev/null || true

if [ "${1:-}" = "--purge" ]; then
    rm -rf "${DATA}" "${HOME}/.config/gnome-typer" "${HOME}/.cache/gnome-typer"
    echo "purged packs, config and cache too."
fi
echo "uninstalled."
