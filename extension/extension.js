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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Daemon, writeConfig} from './daemon.js';

const ICON = 'input-keyboard-symbolic';

// Dragging the volume slider emits a settings change per frame. Coalescing
// them keeps us from rewriting the config file dozens of times a second.
const SYNC_DELAY_MS = 200;

// Purely cosmetic keys: changing them need not touch the daemon's config.
const SHELL_ONLY_KEYS = ['show-indicator'];

/* -------------------------------------------------------------------- UI */

const TyperToggle = GObject.registerClass(
class TyperToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, daemon) {
        super._init({
            title: _('Typer'),
            iconName: ICON,
            toggleMode: true,
        });

        const settings = extension.getSettings();
        this._extension = extension;
        this._settings = settings;
        this._daemon = daemon;
        this._packItems = new Map();
        this._destroyed = false;

        this.menu.setHeader(ICON, _('GNOME Typer'), _('Keyboard sounds'));

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
        this.menu.addAction(_('Settings…'), () => {
            Main.overview.hide();
            Main.panel.closeQuickSettings();
            this._extension.openPreferences();
        });

        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        this._settingsIds = [
            settings.connect('changed::pack', () => this._markActivePack()),
            // The switches are also reachable from the preferences window.
            settings.connect('changed::key-up-sounds', () =>
                this._keyUpItem.setToggleState(settings.get_boolean('key-up-sounds'))),
            settings.connect('changed::velocity-enabled', () =>
                this._velocityItem.setToggleState(settings.get_boolean('velocity-enabled'))),
        ];

        // Packs can be installed from the preferences window while the shell
        // is running, so re-read the list whenever the menu is opened.
        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this.refreshPacks();
        });

        this.refreshPacks();
    }

    async refreshPacks() {
        const packs = await this._daemon.listPacks();
        if (this._destroyed)
            return;                     // menu went away while we were shelling out

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

        const item = this._packItems.get(active);
        this.subtitle = item ? item.label.text : null;
    }

    destroy() {
        this._destroyed = true;
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
});

const VolumeSlider = GObject.registerClass(
class VolumeSlider extends QuickSettings.QuickSlider {
    _init(settings) {
        super._init({iconName: 'audio-speakers-symbolic'});
        this._settings = settings;
        this._changing = false;

        this.slider.connect('notify::value', () => {
            if (!this._changing)
                this._settings.set_double('volume', this.slider.value);
        });
        this._settingsId = settings.connect('changed::volume', () => this._sync());
        this._sync();
    }

    _sync() {
        // Guard against the settings write we just made bouncing back.
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
    _init(extension, daemon) {
        super._init();
        const settings = extension.getSettings();
        this._settings = settings;

        this._icon = this._addIndicator();
        this._icon.iconName = ICON;

        this.toggle = new TyperToggle(extension, daemon);
        this.slider = new VolumeSlider(settings);
        this.quickSettingsItems.push(this.toggle, this.slider);

        this._ids = [
            settings.connect('changed::show-indicator', () => this._syncVisible()),
            settings.connect('changed::enabled', () => this._syncVisible()),
        ];
        this._syncVisible();
    }

    _syncVisible() {
        this._icon.visible = this._settings.get_boolean('show-indicator') &&
                             this._settings.get_boolean('enabled');
    }

    destroy() {
        for (const id of this._ids ?? [])
            this._settings.disconnect(id);
        this._ids = [];
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

/* --------------------------------------------------------------- extension */

export default class GnomeTyperExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._daemon = new Daemon(this.path);
        this._syncSource = 0;

        writeConfig(this._settings);

        this._indicator = new TyperIndicator(this, this._daemon);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._changedId = this._settings.connect('changed', (_s, key) => {
            if (!SHELL_ONLY_KEYS.includes(key))
                this._queueSync();
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

    /** Write the config file once the settings stop moving. */
    _queueSync() {
        if (this._syncSource)
            GLib.Source.remove(this._syncSource);
        this._syncSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DELAY_MS, () => {
            this._syncSource = 0;
            if (this._settings)
                writeConfig(this._settings);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyEnabled() {
        if (this._settings.get_boolean('enabled'))
            this._daemon.start();
        else
            this._daemon.stop();
    }

    disable() {
        if (this._syncSource) {
            GLib.Source.remove(this._syncSource);
            this._syncSource = 0;
            // A pending change would otherwise be lost on lock/unlock.
            writeConfig(this._settings);
        }
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
