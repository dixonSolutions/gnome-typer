/* Run through tools/test-config-sync.sh; no live settings are touched. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {configPath, writeConfig} from '../extension/daemon.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.gnome-typer'});
const file = Gio.File.new_for_path(configPath());
file.get_parent().make_directory_with_parents(null);
const custom = {
    pack: 'thock',
    devices: ['/dev/input/event-example'],
    exclude_devices: ['Power Button'],
    velocity: {release_ratio: 0.27, amount: 0.1},
};
GLib.file_set_contents(configPath(), JSON.stringify(custom));
settings.set_double('volume', 0.31);
settings.set_string('pack', 'click');
assert(writeConfig(settings), 'first sync must update settings');
const [, bytes] = file.load_contents(null);
const result = JSON.parse(new TextDecoder().decode(bytes));
assert(result.volume === 0.31 && result.pack === 'click', 'managed settings must update');
assert(result.devices[0] === custom.devices[0], 'explicit devices must survive');
assert(result.exclude_devices[0] === 'Power Button', 'device filters must survive');
assert(result.velocity.release_ratio === 0.27, 'manual release gain must survive');
assert(result.velocity.amount === settings.get_double('velocity-amount'), 'managed nested values must update');
assert(!writeConfig(settings), 'an unchanged sync must not rewrite the file');
print('PASS: settings sync preserves manual config and avoids unchanged writes');
