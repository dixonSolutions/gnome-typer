/* GNOME Typer preferences. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {findDaemon, runAsync, parseJson} from './daemon.js';

export default class GnomeTyperPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._settings = settings;
        this._daemon = findDaemon(this.path);

        window.set_default_size(720, 780);
        window.add(this._generalPage(settings));
        window.add(this._dynamicsPage(settings));
        window.add(this._keysPage(settings));
        window.add(this._packsPage(settings, window));
    }

    /* ------------------------------------------------------------ general */
    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: _('Sound')});
        page.add(group);

        const enabled = new Adw.SwitchRow({
            title: _('Keyboard sounds'),
            subtitle: _('Start or stop the gnome-typer daemon'),
        });
        settings.bind('enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        this._packRow = new Adw.ComboRow({
            title: _('Sound pack'),
            model: new Gtk.StringList(),
        });
        group.add(this._packRow);
        this._loadPacks(settings);

        group.add(this._sliderRow(settings, 'volume', _('Volume'), '', 0, 1, 0.01));
        group.add(this._sliderRow(settings, 'stereo', _('Stereo spread'),
            _('Pan each key by where it sits on the keyboard'), 0, 1, 0.01));

        const events = new Adw.PreferencesGroup({
            title: _('Events'),
            description: _('Which key events make a sound'),
        });
        page.add(events);

        const keyUp = new Adw.SwitchRow({
            title: _('Key release'),
            subtitle: _('Play a softer sound when a key comes back up'),
        });
        settings.bind('key-up-sounds', keyUp, 'active', Gio.SettingsBindFlags.DEFAULT);
        events.add(keyUp);

        const repeat = new Adw.SwitchRow({
            title: _('Auto-repeat'),
            subtitle: _('Keep sounding while a key is held down'),
        });
        settings.bind('repeat-sounds', repeat, 'active', Gio.SettingsBindFlags.DEFAULT);
        events.add(repeat);

        const indicator = new Adw.SwitchRow({title: _('Show panel indicator')});
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        events.add(indicator);

        return page;
    }

    /* ----------------------------------------------------------- dynamics */
    _dynamicsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Dynamics'),
            icon_name: 'audio-volume-high-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Velocity'),
            description: _('Keyboards cannot report how hard you press — evdev only reports ' +
                           'up and down. Loudness is derived from your typing rhythm instead: ' +
                           'fast bursts read as hard, deliberate keys read as soft.'),
        });
        page.add(group);

        const on = new Adw.SwitchRow({title: _('Vary loudness while typing')});
        settings.bind('velocity-enabled', on, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(on);

        group.add(this._sliderRow(settings, 'velocity-amount', _('Range'),
            _('How much the volume is allowed to swing'), 0, 1, 0.01));
        group.add(this._sliderRow(settings, 'humanize', _('Humanise'),
            _('Random variation applied to every hit'), 0, 0.5, 0.01));

        const timing = new Adw.PreferencesGroup({
            title: _('Timing thresholds'),
            description: _('The gap between keystrokes that counts as hardest and softest'),
        });
        page.add(timing);

        const fast = new Adw.SpinRow({
            title: _('Hardest at or below'),
            subtitle: _('milliseconds between keys'),
            adjustment: new Gtk.Adjustment({lower: 10, upper: 400, step_increment: 5}),
        });
        settings.bind('velocity-fast-ms', fast, 'value', Gio.SettingsBindFlags.DEFAULT);
        timing.add(fast);

        const slow = new Adw.SpinRow({
            title: _('Softest at or above'),
            subtitle: _('milliseconds between keys'),
            adjustment: new Gtk.Adjustment({lower: 80, upper: 2000, step_increment: 10}),
        });
        settings.bind('velocity-slow-ms', slow, 'value', Gio.SettingsBindFlags.DEFAULT);
        timing.add(slow);

        return page;
    }

    /* --------------------------------------------------------------- keys */
    _keysPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Keys'),
            icon_name: 'input-keyboard-symbolic',
        });

        this._keyGroup = new Adw.PreferencesGroup({
            title: _('Per-key sounds'),
            description: _('Give a specific key its own sound category from the pack, ' +
                           'for example KEY_ENTER → bell.'),
        });
        this._keyGroup.set_header_suffix(this._addButton(() => this._addKeyDialog(settings)));
        page.add(this._keyGroup);
        this._rebuildKeys(settings);

        this._comboGroup = new Adw.PreferencesGroup({
            title: _('Key combinations'),
            description: _('Sound a combination differently, for example ' +
                           'KEY_LEFTCTRL + KEY_S → bell. Longer combinations win.'),
        });
        this._comboGroup.set_header_suffix(this._addButton(() => this._addComboDialog(settings)));
        page.add(this._comboGroup);
        this._rebuildCombos(settings);

        return page;
    }

    _addButton(onClick) {
        const button = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Add'),
        });
        button.connect('clicked', onClick);
        return button;
    }

    _rebuildKeys(settings) {
        this._keyRows?.forEach(row => this._keyGroup.remove(row));
        this._keyRows = [];
        const map = parseJson(settings.get_string('key-sounds'), {});
        const names = Object.keys(map);

        if (!names.length) {
            const row = new Adw.ActionRow({
                title: _('No per-key sounds'),
                subtitle: _('The pack’s own defaults are used'),
            });
            this._keyGroup.add(row);
            this._keyRows.push(row);
            return;
        }
        for (const name of names) {
            const row = new Adw.ActionRow({title: name, subtitle: `→ ${map[name]}`});
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => {
                delete map[name];
                settings.set_string('key-sounds', JSON.stringify(map));
                this._rebuildKeys(settings);
            });
            row.add_suffix(remove);
            this._keyGroup.add(row);
            this._keyRows.push(row);
        }
    }

    _rebuildCombos(settings) {
        this._comboRows?.forEach(row => this._comboGroup.remove(row));
        this._comboRows = [];
        const combos = parseJson(settings.get_string('combos'), []);

        if (!combos.length) {
            const row = new Adw.ActionRow({title: _('No key combinations')});
            this._comboGroup.add(row);
            this._comboRows.push(row);
            return;
        }
        combos.forEach((combo, index) => {
            const row = new Adw.ActionRow({
                title: (combo.keys ?? []).join(' + '),
                subtitle: `→ ${combo.sound}`,
            });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => {
                combos.splice(index, 1);
                settings.set_string('combos', JSON.stringify(combos));
                this._rebuildCombos(settings);
            });
            row.add_suffix(remove);
            this._comboGroup.add(row);
            this._comboRows.push(row);
        });
    }

    _entryDialog(title, fields, onAccept) {
        const dialog = new Adw.Window({
            title,
            modal: true,
            default_width: 420,
            transient_for: this._keyGroup.get_root(),
        });
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        const header = new Adw.HeaderBar({show_end_title_buttons: false});
        const cancel = new Gtk.Button({label: _('Cancel')});
        const accept = new Gtk.Button({label: _('Add'), css_classes: ['suggested-action']});
        header.pack_start(cancel);
        header.pack_end(accept);
        box.append(header);

        const group = new Adw.PreferencesGroup({
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
        });
        const entries = fields.map(field => {
            const row = new Adw.EntryRow({title: field.label});
            if (field.placeholder)
                row.text = field.placeholder;
            group.add(row);
            return row;
        });
        box.append(group);
        dialog.set_content(box);

        cancel.connect('clicked', () => dialog.close());
        accept.connect('clicked', () => {
            onAccept(entries.map(e => e.text.trim()));
            dialog.close();
        });
        dialog.present();
    }

    _addKeyDialog(settings) {
        this._entryDialog(_('Add per-key sound'), [
            {label: _('Key name (e.g. KEY_ENTER)'), placeholder: 'KEY_'},
            {label: _('Sound category (e.g. bell)')},
        ], ([key, category]) => {
            if (!key || !category)
                return;
            const map = parseJson(settings.get_string('key-sounds'), {});
            map[key.toUpperCase()] = category;
            settings.set_string('key-sounds', JSON.stringify(map));
            this._rebuildKeys(settings);
        });
    }

    _addComboDialog(settings) {
        this._entryDialog(_('Add key combination'), [
            {label: _('Keys, comma separated'), placeholder: 'KEY_LEFTCTRL, KEY_S'},
            {label: _('Sound category')},
        ], ([keysText, category]) => {
            const keys = keysText.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
            if (keys.length < 2 || !category)
                return;
            const combos = parseJson(settings.get_string('combos'), []);
            combos.push({keys, sound: category});
            settings.set_string('combos', JSON.stringify(combos));
            this._rebuildCombos(settings);
        });
    }

    /* -------------------------------------------------------------- packs */
    _packsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('Packs'),
            icon_name: 'folder-music-symbolic',
        });

        this._installedGroup = new Adw.PreferencesGroup({title: _('Installed')});
        page.add(this._installedGroup);

        const remote = new Adw.PreferencesGroup({
            title: _('Get more packs'),
            description: _('Download a pack from the catalogue, or paste the URL of a ' +
                           'pack zip. Mechvibes packs are converted on import.'),
        });
        page.add(remote);

        const indexRow = new Adw.EntryRow({title: _('Catalogue URL')});
        indexRow.text = settings.get_string('pack-index-url');
        indexRow.connect('changed', () => settings.set_string('pack-index-url', indexRow.text));
        remote.add(indexRow);

        const urlRow = new Adw.EntryRow({title: _('Install from URL or path')});
        const installButton = new Gtk.Button({
            label: _('Install'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        urlRow.add_suffix(installButton);
        remote.add(urlRow);

        const status = new Adw.ActionRow({title: _('Ready')});
        remote.add(status);

        installButton.connect('clicked', async () => {
            const target = urlRow.text.trim();
            if (!target || !this._daemon)
                return;
            status.title = _('Installing…');
            const isMechvibes = !target.toLowerCase().startsWith('http') &&
                                !target.toLowerCase().endsWith('.zip');
            const argv = isMechvibes
                ? [this._daemon, '--import-mechvibes', target]
                : [this._daemon, '--install-pack', target];
            const {ok, stdout, stderr} = await runAsync(argv);
            status.title = ok ? (stdout.trim().split('\n')[0] || _('Installed'))
                              : (stderr.trim().split('\n').pop() || _('Install failed'));
            if (ok) {
                this._loadPacks(settings);
                this._loadInstalled(settings);
            }
        });

        const browse = new Adw.ActionRow({
            title: _('Browse the catalogue'),
            subtitle: _('Fetch the list of downloadable packs'),
            activatable: true,
        });
        browse.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        browse.connect('activated', () => this._browseCatalogue(settings, window, status));
        remote.add(browse);

        this._loadInstalled(settings);
        return page;
    }

    async _browseCatalogue(settings, window, status) {
        if (!this._daemon)
            return;
        status.title = _('Fetching catalogue…');
        const {ok, stdout, stderr} = await runAsync([
            this._daemon, '--list-remote', '--json',
            '--index-url', settings.get_string('pack-index-url'),
        ]);
        if (!ok) {
            status.title = stderr.trim().split('\n').pop() || _('Could not reach the catalogue');
            return;
        }
        const entries = parseJson(stdout, []);
        if (!entries.length) {
            status.title = _('The catalogue is empty');
            return;
        }
        status.title = `${entries.length} ${_('packs available')}`;

        const page = new Adw.PreferencesPage({title: _('Catalogue')});
        const group = new Adw.PreferencesGroup({title: _('Available packs')});
        page.add(group);
        for (const entry of entries) {
            const row = new Adw.ActionRow({
                title: entry.name ?? entry.id,
                subtitle: entry.description ?? '',
            });
            const button = new Gtk.Button({label: _('Install'), valign: Gtk.Align.CENTER});
            button.connect('clicked', async () => {
                button.label = _('Installing…');
                button.sensitive = false;
                const res = await runAsync([
                    this._daemon, '--install-pack', entry.id,
                    '--index-url', settings.get_string('pack-index-url'),
                ]);
                button.label = res.ok ? _('Installed') : _('Failed');
                if (res.ok) {
                    this._loadPacks(settings);
                    this._loadInstalled(settings);
                }
            });
            row.add_suffix(button);
            group.add(row);
        }
        window.add(page);
        window.set_visible_page(page);
    }

    /** Downloaded packs live here; anything else is a builtin and is not removable. */
    _userPackDir() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-typer', 'packs']);
    }

    async _loadInstalled(settings) {
        this._installedRows?.forEach(row => this._installedGroup.remove(row));
        this._installedRows = [];
        if (!this._daemon) {
            const row = new Adw.ActionRow({
                title: _('Daemon not found'),
                subtitle: _('Run install.sh from the gnome-typer repository'),
            });
            this._installedGroup.add(row);
            this._installedRows.push(row);
            return;
        }
        const {ok, stdout} = await runAsync([this._daemon, '--list-packs', '--json']);
        const list = ok ? parseJson(stdout, []) : [];
        const active = settings.get_string('pack');
        const userDir = this._userPackDir();

        for (const pack of list) {
            const row = new Adw.ActionRow({
                title: pack.name ?? pack.id,
                subtitle: pack.description ?? '',
            });

            if (pack.id === active) {
                row.add_suffix(new Gtk.Image({icon_name: 'object-select-symbolic'}));
            } else {
                const use = new Gtk.Button({label: _('Use'), valign: Gtk.Align.CENTER});
                use.connect('clicked', () => {
                    settings.set_string('pack', pack.id);
                    this._loadInstalled(settings);
                });
                row.add_suffix(use);
            }

            if (typeof pack.path === 'string' && pack.path.startsWith(userDir)) {
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: _('Remove this pack'),
                });
                remove.connect('clicked', async () => {
                    remove.sensitive = false;
                    const res = await runAsync([this._daemon, '--remove-pack', pack.id]);
                    if (!res.ok) {
                        remove.sensitive = true;
                        return;
                    }
                    // Removing the pack in use would leave the daemon with
                    // nothing to play, so fall back to a builtin.
                    if (pack.id === settings.get_string('pack'))
                        settings.set_string('pack', 'crunch');
                    this._loadPacks(settings);
                    this._loadInstalled(settings);
                });
                row.add_suffix(remove);
            }

            this._installedGroup.add(row);
            this._installedRows.push(row);
        }
    }

    async _loadPacks(settings) {
        if (!this._daemon || !this._packRow)
            return;
        const {ok, stdout} = await runAsync([this._daemon, '--list-packs', '--json']);
        const list = ok ? parseJson(stdout, []) : [];
        const model = new Gtk.StringList();
        this._packIds = [];
        for (const pack of list) {
            model.append(pack.name ?? pack.id);
            this._packIds.push(pack.id);
        }
        // Assigning a model resets `selected` to 0, which would otherwise fire
        // the handler and write the first pack into GSettings. Disconnect
        // across the whole rebuild and reconnect once the real one is chosen.
        if (this._packRowId) {
            this._packRow.disconnect(this._packRowId);
            this._packRowId = null;
        }
        this._packRow.model = model;

        const active = this._packIds.indexOf(settings.get_string('pack'));
        if (active >= 0)
            this._packRow.selected = active;

        this._packRowId = this._packRow.connect('notify::selected', () => {
            const id = this._packIds[this._packRow.selected];
            if (id)
                settings.set_string('pack', id);
        });
    }

    _sliderRow(settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.ActionRow({title, subtitle});
        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
            digits: 2,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 240,
            valign: Gtk.Align.CENTER,
        });
        scale.set_value(settings.get_double(key));
        scale.connect('value-changed', () => settings.set_double(key, scale.get_value()));
        settings.connect(`changed::${key}`, () => {
            if (Math.abs(scale.get_value() - settings.get_double(key)) > 1e-6)
                scale.set_value(settings.get_double(key));
        });
        row.add_suffix(scale);
        return row;
    }
}
