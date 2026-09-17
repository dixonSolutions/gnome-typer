/* GNOME Typer - keyboard sounds for GNOME on Wayland.
 *
 * The shell side is deliberately thin: it owns the UI and the settings, and
 * mirrors those settings into ~/.config/gnome-typer/config.json. The daemon
 * watches that file and hot-reloads, so nothing here ever blocks the
 * compositor doing audio work.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const SERVICE = 'gnome-typer.service';
const CONFIG_REL = ['gnome-typer', 'config.json'];

/* ------------------------------------------------------------------ utils */

function configPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), ...CONFIG_REL]);
}

/** Locate the daemon: user install first, then system, then a dev checkout. */
function daemonPath() {
    const candidates = [
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gnome-typer']),
        '/usr/local/bin/gnome-typer',
        '/usr/bin/gnome-typer',
        GLib.build_filenamev([GLib.get_home_dir(), 'Projects', 'gnome-typer', 'daemon', 'gnome-typer']),
    ];
    return candidates.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/** Run a command, resolving with stdout. Never throws into the shell. */
function runAsync(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
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

/* --------------------------------------------------------------- daemon io */

class Daemon {
    constructor() {
        this._path = daemonPath();
    }

    get available() {
        return this._path !== null;
    }

    async isRunning() {
        const {stdout} = await runAsync(['systemctl', '--user', 'is-active', SERVICE]);
        return stdout.trim() === 'active';
    }

    /** Prefer systemd so the daemon survives shell restarts; fall back to spawning. */
    async start() {
        const unit = GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', SERVICE]);
        if (GLib.file_test(unit, GLib.FileTest.EXISTS))
            return runAsync(['systemctl', '--user', 'start', SERVICE]);
        if (!this._path)
            return {ok: false, stderr: 'daemon binary not found'};
        try {
            Gio.Subprocess.new([this._path], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            return {ok: true};
        } catch (e) {
            return {ok: false, stderr: String(e)};
        }
    }

    async stop() {
        const unit = GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', SERVICE]);
        if (GLib.file_test(unit, GLib.FileTest.EXISTS))
            return runAsync(['systemctl', '--user', 'stop', SERVICE]);
        return runAsync(['pkill', '-f', 'gnome_typer.cli|gnome-typer$']);
    }

    async listPacks() {
        if (!this._path)
            return [];
        const {ok, stdout} = await runAsync([this._path, '--list-packs', '--json']);
        if (!ok)
            return [];
        try {
            return JSON.parse(stdout);
        } catch {
            return [];
        }
    }
}

/* ------------------------------------------------------- settings -> config */

function parseJson(text, fallback) {
    try {
        const value = JSON.parse(text);
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

/** Write the daemon's JSON config from GSettings. */
function syncConfig(settings) {
    const cfg = {
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

    const path = configPath();
    const dir = Gio.File.new_for_path(path).get_parent();
    try {
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        const text = new TextEncoder().encode(`${JSON.stringify(cfg, null, 2)}\n`);
        // Replace atomically so the daemon never reads a half-written file.
        Gio.File.new_for_path(path).replace_contents(
            text, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
        logError(e, 'gnome-typer: could not write config');
    }
}

/* -------------------------------------------------------------------- UI */

const TyperToggle = GObject.registerClass(
class TyperToggle extends QuickSettings.QuickMenuToggle {
    _init(settings, daemon) {
        super._init({
            title: _('Typer'),
            iconName: 'input-keyboard-symbolic',
            toggleMode: true,
        });

        this._settings = settings;
        this._daemon = daemon;
        this._packItems = new Map();

        this.menu.setHeader('input-keyboard-symbolic', _('GNOME Typer'), _('Keyboard sounds'));

        this._packSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._packSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._keyUpItem = new PopupMenu.PopupSwitchMenuItem(
            _('Key release sounds'), settings.get_boolean('key-up-sounds'));
        this._keyUpItem.connect('toggled', (_i, state) =>
            settings.set_boolean('key-up-sounds', state));
        this.menu.addMenuItem(this._keyUpItem);

        this._velocityItem = new PopupMenu.PopupSwitchMenuItem(
            _('Velocity dynamics'), settings.get_boolean('velocity-enabled'));
        this._velocityItem.connect('toggled', (_i, state) =>
            settings.set_boolean('velocity-enabled', state));
        this.menu.addMenuItem(this._velocityItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = this.menu.addAction(_('Settings…'), () => {
            Main.overview.hide();
            Main.panel.closeQuickSettings();
            try {
                Gio.DBus.session.call(
                    'org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                    'org.gnome.Shell.Extensions', 'OpenExtensionPrefs',
                    new GLib.Variant('(ssa{sv})', ['gnome-typer@dixonsolutions.github.io', '', {}]),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
            } catch (e) {
                logError(e);
            }
        });
        prefs.visible = true;

        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this._packChangedId = settings.connect('changed::pack', () => this._markActivePack());
        this.refreshPacks();
    }

    async refreshPacks() {
        const packs = await this._daemon.listPacks();
        this._packSection.removeAll();
        this._packItems.clear();

        if (!packs.length) {
            const item = new PopupMenu.PopupMenuItem(_('No sound packs found'));
            item.setSensitive(false);
            this._packSection.addMenuItem(item);
            return;
        }
        for (const pack of packs) {
            const item = new PopupMenu.PopupMenuItem(pack.name ?? pack.id);
            item.connect('activate', () => this._settings.set_string('pack', pack.id));
            this._packSection.addMenuItem(item);
            this._packItems.set(pack.id, item);
        }
        this._markActivePack();
    }

    _markActivePack() {
        const active = this._settings.get_string('pack');
        for (const [id, item] of this._packItems)
            item.setOrnament(id === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    destroy() {
        if (this._packChangedId) {
            this._settings.disconnect(this._packChangedId);
            this._packChangedId = null;
        }
        super.destroy();
    }
});

const VolumeSlider = GObject.registerClass(
class VolumeSlider extends QuickSettings.QuickSlider {
    _init(settings) {
        super._init({iconName: 'audio-speakers-symbolic'});
        this._settings = settings;
        this._changing = false;

        this._sliderId = this.slider.connect('notify::value', () => {
            if (this._changing)
                return;
            this._settings.set_double('volume', this.slider.value);
        });
        this._settingsId = settings.connect('changed::volume', () => this._sync());
        this._sync();
    }

    _sync() {
        this._changing = true;
        this.slider.value = this._settings.get_double('volume');
        this._changing = false;
    }

    destroy() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        super.destroy();
    }
});

const TyperIndicator = GObject.registerClass(
class TyperIndicator extends QuickSettings.SystemIndicator {
    _init(settings, daemon) {
        super._init();
        this._settings = settings;

        this._icon = this._addIndicator();
        this._icon.iconName = 'input-keyboard-symbolic';

        this.toggle = new TyperToggle(settings, daemon);
        this.slider = new VolumeSlider(settings);
        this.quickSettingsItems.push(this.toggle, this.slider);

        this._visId = settings.connect('changed::show-indicator', () => this._syncVisible());
        this._enabledId = settings.connect('changed::enabled', () => this._syncVisible());
        this._syncVisible();
    }

    _syncVisible() {
        this._icon.visible = this._settings.get_boolean('show-indicator') &&
                             this._settings.get_boolean('enabled');
    }

    destroy() {
        for (const id of [this._visId, this._enabledId]) {
            if (id)
                this._settings.disconnect(id);
        }
        this._visId = this._enabledId = null;
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

/* --------------------------------------------------------------- extension */

export default class GnomeTyperExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._daemon = new Daemon();

        syncConfig(this._settings);

        this._indicator = new TyperIndicator(this._settings, this._daemon);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // Any setting change is mirrored to the daemon's config file.
        this._changedId = this._settings.connect('changed', (_s, key) => {
            syncConfig(this._settings);
            if (key === 'enabled')
                this._applyEnabled();
        });

        if (!this._daemon.available) {
            Main.notifyError(_('GNOME Typer'),
                _('Daemon not found. Run install.sh from the gnome-typer repository.'));
        } else {
            this._applyEnabled();
        }
    }

    _applyEnabled() {
        if (this._settings.get_boolean('enabled'))
            this._daemon.start();
        else
            this._daemon.stop();
    }

    disable() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        // Leave the daemon's running state alone: the user may have enabled it
        // deliberately, and lock-screen disables should not silence the keyboard.
        this._daemon = null;
        this._settings = null;
    }
}
