/* Talking to the gnome-typer daemon.
 *
 * Shared by extension.js (shell process) and prefs.js (a separate gjs
 * process), which is the point: both need to locate the binary and shell out
 * to it, and when those two drifted apart they disagreed about where the
 * daemon lived.
 *
 * The daemon takes its configuration from ~/.config/gnome-typer/config.json
 * rather than GSettings - it is plain Python with no PyGObject dependency -
 * so writing that file is how the shell side applies a setting. The daemon
 * polls its mtime and hot-reloads, so no restart is involved.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SERVICE = 'gnome-typer.service';

export function configPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'gnome-typer', 'config.json']);
}

function unitPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', SERVICE]);
}

/**
 * Locate the daemon: an explicit override first, then the installed copies,
 * then a daemon shipped beside the extension, and finally $PATH.
 *
 * `extensionPath` is the extension's own directory - passing it is what lets
 * a source checkout work without installing anything.
 */
export function findDaemon(extensionPath = null) {
    const candidates = [];
    const override = GLib.getenv('GNOME_TYPER_DAEMON');
    if (override)
        candidates.push(override);
    candidates.push(
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gnome-typer']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-typer', 'daemon', 'gnome-typer']),
        '/usr/local/bin/gnome-typer',
        '/usr/bin/gnome-typer'
    );
    if (extensionPath) {
        candidates.push(
            GLib.build_filenamev([extensionPath, 'daemon', 'gnome-typer']),
            // extension/ and daemon/ are siblings in a source checkout.
            GLib.build_filenamev([extensionPath, '..', 'daemon', 'gnome-typer'])
        );
    }
    const found = candidates.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE));
    return found ?? GLib.find_program_in_path('gnome-typer');
}

/** Run a command, resolving with its output. Never throws into the caller. */
export function runAsync(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: String(e)});
            return;
        }
        proc.communicate_utf8_async(null, null, (src, res) => {
            try {
                const [, stdout, stderr] = src.communicate_utf8_finish(res);
                resolve({ok: src.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                resolve({ok: false, stdout: '', stderr: String(e)});
            }
        });
    });
}

export function parseJson(text, fallback) {
    try {
        return JSON.parse(text) ?? fallback;
    } catch {
        return fallback;
    }
}

/** GSettings -> the shape the daemon's config.json expects. */
export function settingsToConfig(settings) {
    return {
        enabled: settings.get_boolean('enabled'),
        pack: settings.get_string('pack'),
        volume: settings.get_double('volume'),
        key_up_sounds: settings.get_boolean('key-up-sounds'),
        repeat_sounds: settings.get_boolean('repeat-sounds'),
        stereo: settings.get_double('stereo'),
        velocity: {
            enabled: settings.get_boolean('velocity-enabled'),
            amount: settings.get_double('velocity-amount'),
            fast_ms: settings.get_int('velocity-fast-ms'),
            slow_ms: settings.get_int('velocity-slow-ms'),
            humanize: settings.get_double('humanize'),
        },
        key_sounds: parseJson(settings.get_string('key-sounds'), {}),
        combos: parseJson(settings.get_string('combos'), []),
    };
}

/**
 * Mirror GSettings into the daemon's config file.
 * Returns false when the file already said exactly this, so an unchanged
 * write never bumps the mtime the daemon is watching.
 */
export function writeConfig(settings) {
    const text = `${JSON.stringify(settingsToConfig(settings), null, 2)}\n`;
    const file = Gio.File.new_for_path(configPath());
    try {
        const [ok, current] = file.load_contents(null);
        if (ok && new TextDecoder().decode(current) === text)
            return false;
    } catch {
        // No config yet, or unreadable - fall through and write one.
    }
    try {
        const dir = file.get_parent();
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        // Replace atomically so the daemon never reads a half-written file.
        file.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return true;
    } catch (e) {
        logError(e, 'gnome-typer: could not write config');
        return false;
    }
}

/** The daemon as seen from the shell: a binary path and a systemd unit. */
export class Daemon {
    constructor(extensionPath = null) {
        this._path = findDaemon(extensionPath);
    }

    get available() {
        return this._path !== null;
    }

    get path() {
        return this._path;
    }

    /** Prefer systemd so the daemon outlives a shell restart. */
    async start() {
        if (GLib.file_test(unitPath(), GLib.FileTest.EXISTS))
            return runAsync(['systemctl', '--user', 'start', SERVICE]);
        if (!this._path)
            return {ok: false, stdout: '', stderr: 'daemon binary not found'};
        try {
            Gio.Subprocess.new([this._path],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            return {ok: true, stdout: '', stderr: ''};
        } catch (e) {
            return {ok: false, stdout: '', stderr: String(e)};
        }
    }

    async stop() {
        if (GLib.file_test(unitPath(), GLib.FileTest.EXISTS))
            return runAsync(['systemctl', '--user', 'stop', SERVICE]);
        // Anchored so this only matches the daemon, not a shell editing it.
        return runAsync(['pkill', '-f', '^(\\S*python\\S*\\s+)?\\S*gnome-typer$']);
    }

    async _json(argv) {
        if (!this._path)
            return [];
        const {ok, stdout} = await runAsync([this._path, ...argv]);
        if (!ok)
            return [];
        const value = parseJson(stdout, []);
        return Array.isArray(value) ? value : [];
    }

    listPacks() {
        return this._json(['--list-packs', '--json']);
    }

    listRemote(indexUrl) {
        return this._json(['--list-remote', '--json', '--index-url', indexUrl]);
    }

    installPack(target, indexUrl) {
        return runAsync([this._path, '--install-pack', target, '--index-url', indexUrl]);
    }

    importMechvibes(path) {
        return runAsync([this._path, '--import-mechvibes', path]);
    }

    removePack(id) {
        return runAsync([this._path, '--remove-pack', id]);
    }
}
