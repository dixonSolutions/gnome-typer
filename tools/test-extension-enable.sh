#!/bin/bash
#
# Verify the shell extension actually enables, without logging out.
#
# A headless gnome-shell on a private session bus is a real shell: it runs
# enable() for real, so a broken QuickSettings subclass or a missing GSettings
# key shows up here as state 3 (ERROR) instead of biting the user at login.
#
# It is easy to conclude headless "does not enable extensions" and give up. It
# does. An extension sitting at state 6 (INITIALIZED) is simply one that is not
# listed in dconf's enabled-extensions - which is why this script writes that
# key before starting the shell.
#
# Nothing here touches the live session: XDG_CONFIG_HOME is redirected to a
# scratch directory, so the dconf the test shell reads and the config.json the
# extension writes are both throwaway copies. The running daemon keeps its own
# config and never restarts.
#
# Usage: tools/test-extension-enable.sh
# Exit status is 0 only if the extension reaches ENABLED with no errors.

set -u

UUID="gnome-typer@dixonsolutions.github.io"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ ! -d "$INSTALL_DIR" ]; then
    echo "not installed: $INSTALL_DIR" >&2
    echo "run ./install.sh first - the shell only loads what is installed" >&2
    exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ExtensionState, from gnome-shell's extensionSystem.js.
state_name() {
    case "$1" in
        1) echo "ENABLED" ;;
        2) echo "DISABLED" ;;
        3) echo "ERROR" ;;
        4) echo "OUT_OF_DATE" ;;
        5) echo "DOWNLOADING" ;;
        6) echo "INITIALIZED (never enabled - is it in enabled-extensions?)" ;;
        7) echo "DISABLING" ;;
        8) echo "ENABLING" ;;
        *) echo "unknown ($1)" ;;
    esac
}

inner() {
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
    dconf write /org/gnome/shell/disable-user-extensions "false"

    gnome-shell --headless --virtual-monitor 1280x800 >"$WORK/shell.log" 2>&1 &
    local pid=$!

    local i
    for i in $(seq 1 40); do
        sleep 1
        gdbus call --session --dest org.gnome.Shell \
            --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Extensions.ListExtensions \
            >/dev/null 2>&1 && break
    done
    # enable() is queued behind startup; give it room to run and settle.
    sleep 10

    info() {
        gdbus call --session --dest org.gnome.Shell \
            --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" 2>&1
    }

    local state
    state=$(info | tr ',' '\n' | sed -n "s/.*'state': <\([0-9]*\).*/\1/p")
    echo "after startup:  state $state - $(state_name "$state")"

    # A clean lock/unlock is a disable()/enable() cycle, so exercise one:
    # leaked signal handlers and timers show up as errors on the way back.
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.DisableExtension "$UUID" >/dev/null 2>&1
    sleep 3
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.EnableExtension "$UUID" >/dev/null 2>&1
    sleep 3

    local state2
    state2=$(info | tr ',' '\n' | sed -n "s/.*'state': <\([0-9]*\).*/\1/p")
    echo "after re-enable: state $state2 - $(state_name "$state2")"

    local errors
    errors=$(gdbus call --session --dest org.gnome.Shell \
        --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionErrors "$UUID" 2>&1)
    echo "errors: $errors"

    # enable() is supposed to mirror GSettings into the daemon's config file.
    if [ -s "$XDG_CONFIG_HOME/gnome-typer/config.json" ]; then
        echo "config.json: written ($(wc -c <"$XDG_CONFIG_HOME/gnome-typer/config.json") bytes)"
    else
        echo "config.json: MISSING - enable() did not write it"
    fi

    # prefs.js runs in its own gjs process, so nothing above touches it. Open
    # the window and watch the log: OpenExtensionPrefs returns () whether or
    # not prefs.js blew up, so its return value proves nothing. A failed import
    # surfaces only as "JS ERROR: Failed to open preferences".
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.OpenExtensionPrefs "$UUID" "" "{}" \
        >/dev/null 2>&1
    sleep 10

    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null

    [ "$state2" = "1" ] && [ "$errors" = "(@as [],)" ]
}

export XDG_CONFIG_HOME="$WORK/config"
mkdir -p "$XDG_CONFIG_HOME"
export -f state_name

# prefs.js runs in a D-Bus activated gjs process, so its stderr lands on the
# session bus daemon's stderr - here - rather than in the shell log. Keep it.
XDG_CONFIG_HOME="$XDG_CONFIG_HOME" WORK="$WORK" UUID="$UUID" \
    dbus-run-session -- bash -c "$(declare -f state_name inner); inner" \
    2>"$WORK/session.log"
enabled_ok=$?

# OpenExtensionPrefs returns () whether or not prefs.js blew up, so its return
# value proves nothing; a failed import shows up only as a logged JS ERROR.
prefs_err=$(grep -hiE "Failed to open preferences|JS ERROR|Unhandled promise" \
    "$WORK/session.log" "$WORK/shell.log" 2>/dev/null)
if [ -n "$prefs_err" ]; then
    echo "prefs: FAILED"
    echo "$prefs_err" | head -10
else
    echo "prefs: opened cleanly"
fi

if [ "$enabled_ok" -eq 0 ] && [ -z "$prefs_err" ]; then
    echo "PASS: $UUID enables cleanly and its preferences window loads"
    exit 0
fi
echo "FAIL: $UUID did not reach ENABLED, or its preferences failed to load" >&2
exit 1
