# GNOME Typer improvement plan and findings

Date: 2026-09-18. Scope: the GNOME keyboard-sound project, tested from a source
checkout under Projects. Search engine work belongs to searchDOESsearch; this
project plays key sounds and does not provide a music search service.

## Baseline and priorities

The clean upstream checkout had four preference pages, four bundled sound packs,
and 28 passing Python tests. Preferences exposed detailed millisecond timing and
a catalogue URL immediately. There was no explicit sound preview and no library
filter, so comparing a pack required selecting it and typing with readable input
devices. This made installation and audio diagnosis unnecessarily coupled.

1. Make choosing a sound understandable: Sound, Typing feel, Keys, Sound library;
   retain working advanced functions behind expanders rather than delete them.
2. Provide explicit, finite playback previews independent of input permissions.
   No automatic preview when opening preferences, filtering, or selecting packs.
3. Correct typing dynamics and state synchronization before claiming improved
   sound quality or latency. Avoid claiming hardware latency measurements.
4. Preserve manually configured device lists and daemon-only options whenever
   the shell writes preferences.
5. Add focused behavior regressions, run native GSettings tests in isolation,
   and have the integration agent exercise real GNOME preferences and snapshots.
6. Install into the user's normal per-user locations after the source is ready;
   keep desktop/session integration and fork publication with the root agent.

## Implemented findings

| Finding | Change | Verification |
| --- | --- | --- |
| No way to hear a pack before choosing it | Per-pack preview plus Sound-page preview; `--preview` plays six presses/releases then exits | CLI test checks playback, cleanup, zero input-device discovery; real audio checked during integration |
| Pack selection hard to browse | Search-enabled selection and library text filter over id/name/description | Real Adwaita preferences QA requested |
| Technical settings crowd normal controls | Plain labels, advanced timing and custom catalogue expanders, disabled rhythm controls when rhythm off | JS syntax and real preferences QA |
| Release sounds use a constant gain even after a soft press | Track original strike level per key, use it for release | Regression covers an overlapping second press |
| Repeating a held key increases rhythm estimate | Reuse initial strike loudness for repeats | Regression compares next key after repeated versus unrepeated hold |
| Startup or unknown events can produce release sounds | Ignore orphan release and invalid event values | Two focused engine tests |
| Config reload and device threads share unprotected state | Serialize event routing with existing reconfiguration lock | Existing routing/combination tests retained; no hardware timing claim |
| Shell overwrites manual device filters and release ratio | Merge managed fields into existing config, including nested velocity settings | Native GJS/GSettings test preserves device filters and release_ratio |
| Adjusting volume reloads a switched pack unnecessarily | Compare requested id to engine's current pack | Code inspection; baseline pack tests remain passing |
| Config watcher shadows Thread._stop | Rename stop event so stop/join works | Start/stop/join regression |
| Valid non-object JSON crashes config loading | Fall back to defaults for arrays/scalars/null | Four-value regression |
| Library asynchronous results can arrive out of order | Generation counters discard outdated list responses | UI inspection and syntax checks |
| Selected pack can disagree between library and Sound page | Synchronize active selection through GSettings | Real preferences QA requested |

## Automated validation

Commands run from the checkout:

```sh
python3 -m unittest discover -s tests -v
node --input-type=module --check < extension/prefs.js
node --input-type=module --check < extension/daemon.js
tools/test-config-sync.sh
git diff --check
```

Result: 39 Python tests pass (28 baseline plus 11 new regressions); both JavaScript
modules parse; native GSettings sync and subprocess ownership regressions pass; no whitespace errors.
The GSettings test creates temporary schema/config directories and uses an
in-memory settings backend, so it does not touch the running desktop's settings.

## Runtime validation and remaining limits

The nested-validation agent owns real GNOME Shell enable/disable/preferences
checks and screenshots. Root owns installation, user service status, and
publication. See the consolidated session report for their observed results.
The library filter currently covers installed packs; remote catalogue browsing
still fetches its configured source on explicit request. Preview does not record
keystrokes or open input devices. The live typing field depends on the normal
service being enabled and input access, while Preview does not.

No claim is made that this change reduces measured speaker latency. The existing
PipeWire mixer remains unchanged. Its hardware latency and sound preference
require listening on the user's actual output device. Password/session settings
are outside this work and were not changed.

## Integration discoveries and corrections

Real nested-session validation exposed an upstream cross-session bug: the
fallback daemon stop used global `pkill -f`, which could also stop a daemon
running under the host user service. This has been removed. Fallback execution
now holds the exact Gio.Subprocess in the Shell module, reuses it across
extension instances, sends SIGTERM only to that owned child, and waits for exit.
An isolated native GJS test launches an unrelated process with the same daemon
name, starts/stops the owned daemon, and verifies the unrelated process survives.
The test also validates subprocess stdout tuple handling on installed GJS.

Runtime inspection also found power, sleep, privacy and video-bus hotkey devices
in the keyboard list. Autodetection now requires A, Z and Space capability bits
when a KEY bitmap is available. Explicit device lists still support specialty
hardware. This machine's list falls from eleven to four keyboard-capable nodes:
physical keyboard, keyd virtual keyboard, and two ydotool virtual devices. keyd
normally grabs the physical device; no speculative name-based filtering or
forced exclusion of automation keyboards was added.
