/* Shared helpers: locating the daemon, mirroring GSettings into its config file.
 *
 * The daemon deliberately knows nothing about GSettings (it would drag in
 * PyGObject for no reason), so the extension is the one that translates. It
 * writes ~/.config/gnome-typer/config.json; the daemon polls that file's mtime
 * and hot-reloads, which is why changing a pack or volume needs no restart.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'gnome-typer']);
export const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);

/** Where a daemon may live, best first. */
export function findDaemon(extensionPath = null) {
    const candidates = [];
    const fromEnv = GLib.getenv('GNOME_TYPER_DAEMON');
    if (fromEnv)
        candidates.push(fromEnv);
    if (extensionPath)
        candidates.push(GLib.build_filenamev([extensionPath, 'daemon', 'gnome-typer']));
    candidates.push(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-typer', 'daemon', 'gnome-typer']),
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gnome-typer']),
        '/usr/local/bin/gnome-typer',
        '/usr/bin/gnome-typer'
    );
    for (const path of candidates) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return GLib.find_program_in_path('gnome-typer');
}

function parseJson(text, fallback) {
    try {
        const value = JSON.parse(text);
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

/** GSettings -> the daemon's config.json shape. */
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

/** Write the config file. Returns true if anything actually changed on disk. */
export function writeConfig(settings) {
    const text = `${JSON.stringify(settingsToConfig(settings), null, 2)}\n`;
    const file = Gio.File.new_for_path(CONFIG_PATH);
    try {
        const [, existing] = file.load_contents(null);
        if (new TextDecoder().decode(existing) === text)
            return false;
    } catch {
        // No file yet, or unreadable - write it.
    }
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
        file.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return true;
    } catch (e) {
        logError(e, 'gnome-typer: could not write config');
        return false;
    }
}

/**
 * Ask the daemon which packs it can see.
 * `callback(packs, error)` with packs as [{id, name, description}, ...].
 */
export function listPacks(daemonPath, callback) {
    if (!daemonPath) {
        callback([], new Error('daemon not found'));
        return;
    }
    let proc;
    try {
        proc = Gio.Subprocess.new([daemonPath, '--list-packs', '--json'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        callback([], e);
        return;
    }
    proc.communicate_utf8_async(null, null, (source, result) => {
        try {
            const [, stdout] = source.communicate_utf8_finish(result);
            const packs = parseJson(stdout, []);
            callback(Array.isArray(packs) ? packs : [], null);
        } catch (e) {
            callback([], e);
        }
    });
}
