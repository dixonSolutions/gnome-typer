/* Run via tools/test-config-sync.sh with a synthetic sleeping daemon. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {Daemon, runAsync} from '../extension/daemon.js';

const loop = new GLib.MainLoop(null, false);
let failure = false;
const unrelated = Gio.Subprocess.new([GLib.getenv('GNOME_TYPER_DAEMON')], Gio.SubprocessFlags.NONE);
let unrelatedExited = false;
unrelated.wait_async(null, (child, result) => {
    child.wait_finish(result);
    unrelatedExited = true;
});

async function check() {
    try {
        const output = await runAsync(['/usr/bin/printf', 'pack-json']);
        if (!output.ok || output.stdout !== 'pack-json' || output.stderr !== '')
            throw new Error(`subprocess output tuple is wrong: ${JSON.stringify(output)}`);
        print('PASS: runAsync captures stdout without dropping or shifting outputs');
        const first = new Daemon();
        await first.stop(); // Must not kill the unrelated process by its name.
        await first.start();
        await first.start(); // Repeated enable reuses the owned child.
        await new Daemon().stop(); // Ownership survives a new extension instance.
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        if (unrelatedExited)
            throw new Error('stopping fallback daemon killed an unrelated process');
        print('PASS: fallback stop terminates only the process owned by this Shell');
    } catch (error) {
        printerr(error);
        failure = true;
    } finally {
        unrelated.force_exit();
        unrelated.wait_async(null, (child, result) => {
            child.wait_finish(result);
            loop.quit();
        });
    }
}
check();
loop.run();
if (failure)
    System.exit(1);
