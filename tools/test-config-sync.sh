#!/usr/bin/env bash
# Exercise native Gio/GSettings config sync with isolated config and memory settings.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/schemas"
cp "$ROOT"/extension/schemas/*.gschema.xml "$TEST_DIR/schemas/"
glib-compile-schemas "$TEST_DIR/schemas"
XDG_CONFIG_HOME="$TEST_DIR/config" GSETTINGS_SCHEMA_DIR="$TEST_DIR/schemas" \
    GSETTINGS_BACKEND=memory gjs -m "$ROOT/tests/test-extension-config.js"
# A real sleeping process has the same command-line name as the real daemon,
# but never opens keyboards or audio. Old global pkill logic kills it wrongly.
cat > "$TEST_DIR/gnome-typer" <<'PY'
#!/usr/bin/python3
import time
time.sleep(30)
PY
chmod +x "$TEST_DIR/gnome-typer"
XDG_CONFIG_HOME="$TEST_DIR/config" GNOME_TYPER_DAEMON="$TEST_DIR/gnome-typer" \
    gjs -m "$ROOT/tests/test-daemon-lifecycle.js"
