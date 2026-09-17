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

        this._window = window;
        this._closed = false;
        this._settingsSignals = [];
        window.connect('close-request', () => {
            this._closed = true;
            for (const id of this._settingsSignals)
                settings.disconnect(id);
            this._settingsSignals = [];
            return false;
        });
        window.set_default_size(760, 760);
        window.add(this._generalPage(settings));
        window.add(this._dynamicsPage(settings));
        window.add(this._keysPage(settings));
        window.add(this._packsPage(settings, window));
    }

    /* ------------------------------------------------------------ general */
    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Sound'),
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: _('Sound')});
        page.add(group);

        const enabled = new Adw.SwitchRow({
            title: _('Keyboard sounds'),
            subtitle: _('Play sounds as you type in any application'),
        });
        settings.bind('enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        this._packRow = new Adw.ComboRow({
            title: _('Sound pack'),
            enable_search: true,
            model: new Gtk.StringList(),
        });
        group.add(this._packRow);
        this._tuneModeRow = new Adw.ComboRow({
            title: _('Tune playback'),
            subtitle: _('One note per key keeps the melody connected to your typing'),
            model: Gtk.StringList.new([_('One note per key'), _('Play while typing')]),
        });
        this._tuneModeRow.selected = settings.get_string('tune-mode') === 'flow' ? 1 : 0;
        this._tuneModeRow.connect('notify::selected', () =>
            settings.set_string('tune-mode', this._tuneModeRow.selected === 1 ? 'flow' : 'keystroke'));
        group.add(this._tuneModeRow);
        this._loadPacks(settings);
        this._settingsSignals.push(settings.connect('changed::pack', () => {
            const selected = this._packIds?.indexOf(settings.get_string('pack')) ?? -1;
            if (selected >= 0)
                this._packRow.selected = selected;
            if (this._installedGroup)
                this._loadInstalled(settings);
            this._updateTuneControls();
        }));

        group.add(this._sliderRow(settings, 'volume', _('Volume'), '', 0, 1, 0.01));
        const preview = new Adw.ActionRow({
            title: _('Try this sound'),
            subtitle: _('Hear a short example without changing your keyboard settings'),
        });
        preview.add_suffix(this._previewButton(() => settings.get_string('pack')));
        group.add(preview);

        const typing = new Adw.EntryRow({title: _('Type here to try your settings')});
        group.add(typing);

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
            title: _('Held keys'),
            subtitle: _('Keep sounding while a key is held down'),
        });
        settings.bind('repeat-sounds', repeat, 'active', Gio.SettingsBindFlags.DEFAULT);
        events.add(repeat);

        this._eventGroup = events;
        this._updateTuneControls();



        return page;
    }

    /* ----------------------------------------------------------- dynamics */
    _dynamicsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Typing feel'),
            icon_name: 'audio-volume-high-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Typing rhythm'),
            description: _('Quick bursts sound stronger; slower typing sounds softer. ' +
                           'This follows your pace, not how hard you press.'),
        });
        page.add(group);

        const on = new Adw.SwitchRow({title: _('Vary loudness while typing')});
        settings.bind('velocity-enabled', on, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(on);

        const range = this._sliderRow(settings, 'velocity-amount', _('Loudness variation'),
            _('From an even volume to more expressive typing'), 0, 1, 0.01);
        const variation = this._sliderRow(settings, 'humanize', _('Natural variation'),
            _('Small differences between keystrokes'), 0, 0.5, 0.01);
        group.add(range);
        group.add(variation);
        settings.bind('velocity-enabled', range, 'sensitive', Gio.SettingsBindFlags.GET);
        settings.bind('velocity-enabled', variation, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(this._sliderRow(settings, 'stereo', _('Stereo width'),
            _('Place sounds from left to right across the keyboard'), 0, 1, 0.01));

        const advanced = new Adw.PreferencesGroup();
        page.add(advanced);
        const timing = new Adw.ExpanderRow({
            title: _('Advanced timing'),
            subtitle: _('Adjust the rhythm response in milliseconds'),
        });
        advanced.add(timing);
        settings.bind('velocity-enabled', timing, 'sensitive', Gio.SettingsBindFlags.GET);

        const fast = new Adw.SpinRow({
            title: _('Loudest when faster than'),
            subtitle: _('milliseconds between keys'),
            adjustment: new Gtk.Adjustment({lower: 10, upper: 400, step_increment: 5}),
        });
        settings.bind('velocity-fast-ms', fast, 'value', Gio.SettingsBindFlags.DEFAULT);
        timing.add_row(fast);

        const slow = new Adw.SpinRow({
            title: _('Softest when slower than'),
            subtitle: _('milliseconds between keys'),
            adjustment: new Gtk.Adjustment({lower: 80, upper: 2000, step_increment: 10}),
        });
        settings.bind('velocity-slow-ms', slow, 'value', Gio.SettingsBindFlags.DEFAULT);
        timing.add_row(slow);
        // Keep a meaningful response range even when either threshold moves.
        fast.connect('notify::value', () => {
            if (slow.value <= fast.value)
                settings.set_int('velocity-slow-ms', Math.round(fast.value + 10));
        });
        slow.connect('notify::value', () => {
            if (fast.value >= slow.value)
                settings.set_int('velocity-fast-ms', Math.round(slow.value - 10));
        });
        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        const indicator = new Adw.SwitchRow({title: _('Show panel indicator')});
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(indicator);
        page.add(appearance);

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
            title: _('Sound library'),
            icon_name: 'folder-music-symbolic',
        });

        const searchGroup = new Adw.PreferencesGroup();
        const search = new Gtk.SearchEntry({
            placeholder_text: _('Search sounds by name or description'),
            hexpand: true,
        });
        search.connect('search-changed', () => {
            this._packQuery = search.text.trim().toLocaleLowerCase();
            this._filterPacks();
        });
        searchGroup.add(search);
        page.add(searchGroup);
        this._installedGroup = new Adw.PreferencesGroup({title: _('Installed sounds')});
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
        const source = new Adw.ExpanderRow({
            title: _('Custom catalogue'),
            subtitle: _('Optional: use another sound pack source'),
        });
        source.add_row(indexRow);
        remote.add(source);

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
            installButton.sensitive = false;
            status.title = _('Installing…');
            const isMechvibes = !target.toLowerCase().startsWith('http') &&
                                !target.toLowerCase().endsWith('.zip');
            const argv = isMechvibes
                ? [this._daemon, '--import-mechvibes', target]
                : [this._daemon, '--install-pack', target];
            const {ok, stdout, stderr} = await runAsync(argv);
            if (this._closed)
                return;
            installButton.sensitive = true;
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

        if (this._cataloguePage)
            window.remove(this._cataloguePage);
        const page = new Adw.PreferencesPage({title: _('Catalogue')});
        this._cataloguePage = page;
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
        const request = this._installedRequest = (this._installedRequest ?? 0) + 1;
        if (!this._daemon) {
            const row = new Adw.ActionRow({
                title: _('Daemon not found'),
                subtitle: _('Run install.sh from the gnome-typer repository'),
            });
            this._installedGroup.add(row);
            this._installedRows ??= [];
            this._installedRows.push(row);
            return;
        }
        const {ok, stdout} = await runAsync([this._daemon, '--list-packs', '--json']);
        const list = ok ? parseJson(stdout, []) : [];
        if (this._closed || request !== this._installedRequest)
            return;
        this._installedRows?.forEach(row => this._installedGroup.remove(row));
        this._installedRows = [];
        this._packSearchRows = [];
        const active = settings.get_string('pack');
        const userDir = this._userPackDir();

        for (const pack of list) {
            const row = new Adw.ActionRow({
                title: pack.name ?? pack.id,
                subtitle: pack.description ?? '',
            });

            row.add_suffix(this._previewButton(() => pack.id));
            this._packSearchRows.push({row, text: `${pack.id} ${pack.name ?? ''} ${pack.description ?? ''}`.toLocaleLowerCase()});

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

            if (typeof pack.path === 'string' && pack.path.startsWith(`${userDir}/`)) {
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
        this._filterPacks();
    }

    async _loadPacks(settings) {
        if (!this._daemon || !this._packRow)
            return;
        const request = this._packsRequest = (this._packsRequest ?? 0) + 1;
        const {ok, stdout} = await runAsync([this._daemon, '--list-packs', '--json']);
        if (this._closed || request !== this._packsRequest)
            return;
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
        this._updateTuneControls();
    }

    _filterPacks() {
        let count = 0;
        for (const {row, text} of this._packSearchRows ?? []) {
            row.visible = !this._packQuery || text.includes(this._packQuery);
            if (row.visible)
                count++;
        }
        this._installedGroup.description = count ? '' : _('No matching sounds');
    }

    _updateTuneControls() {
        if (!this._packIds || !this._tuneModeRow)
            return;
        const isTune = this._settings.get_string('pack').startsWith('tune-');
        this._tuneModeRow.visible = isTune;
        if (this._eventGroup)
            this._eventGroup.visible = !isTune;
    }

    _previewButton(packId) {
        const button = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            tooltip_text: _('Preview sound'),
            valign: Gtk.Align.CENTER,
            sensitive: Boolean(this._daemon),
        });
        button.connect('clicked', async () => {
            if (this._previewing)
                return;
            this._previewing = true;
            button.sensitive = false;
            const result = await runAsync([
                this._daemon, '--preview', '--pack', packId(),
                '--volume', String(this._settings.get_double('volume')),
            ]);
            this._previewing = false;
            if (this._closed)
                return;
            button.sensitive = true;
            if (!result.ok)
                this._window.add_toast(new Adw.Toast({title: _('Could not play sound. Check your audio output.')}));
        });
        return button;
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
        this._settingsSignals.push(settings.connect(`changed::${key}`, () => {
            if (Math.abs(scale.get_value() - settings.get_double(key)) > 1e-6)
                scale.set_value(settings.get_double(key));
        }));
        row.add_suffix(scale);
        return row;
    }
}
