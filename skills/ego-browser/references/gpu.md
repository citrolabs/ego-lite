# macOS GPU compatibility modes

Use this guide when ego lite causes sustained GPU activity while its window is visible.

This repository contains the open-source `ego-browser` automation runtime and Skill, not the browser application's Chromium host source. The integrations below are therefore opt-in compatibility workarounds while the browser-side compositor issue is fixed upstream.

## Switch modes inside ego lite

The optional GPU controller adds a toolbar popup to ego lite and uses a restricted native messaging host to persist the selected mode and restart the browser.

```bash
sh skills/ego-browser/gpu-controller/install.sh
```

Complete the one-time unpacked-extension step shown by the installer, then pin **ego GPU Mode** from the extensions menu. Later mode changes happen entirely from that popup. Applying a mode restarts ego lite and ends active Agent tasks.

The controller does not edit or re-sign the ego lite application. Balanced mode is persisted through Chromium's tested `skia-graphite@5` Local State experiment, which produces `--disable-features=SkiaGraphite` during a normal launch. Low-power mode is automatically reapplied because `--disable-webgl` is only accepted at browser startup.

See [`gpu-controller/README.md`](../gpu-controller/README.md) for installation and security details.

## Launch a compatibility mode

Quit ego lite completely before running the launcher. Closing its windows is not enough because Chromium graphics flags only apply when the browser process starts.

```bash
sh skills/ego-browser/scripts/launch-gpu-mode.sh balanced
```

Available modes:

| Mode        | Chromium flag                     | Trade-off                                                                                         |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `normal`    | none                              | Normal ego lite behavior                                                                          |
| `balanced`  | `--disable-features=SkiaGraphite` | Keeps WebGL available but falls back from the Graphite renderer                                   |
| `low-power` | `--disable-webgl`                 | Largest measured GPU reduction; WebGL pages and ego lite visual agent overlays may be unavailable |
| `software`  | `--disable-gpu`                   | Troubleshooting only; shifts rendering work to the CPU and disables hardware video acceleration   |

The standalone script refuses to launch if ego lite is already running. It does not edit the browser profile, Chrome flags preferences, bookmarks, cookies, or extensions.

To return to the default behavior, quit ego lite and open it normally from Finder, Spotlight, or the Dock.

## Reference measurements

The following 12-sample averages were recorded on ego lite `0.4.6.12`, Chromium `150.0.7871.101`, macOS `26.5.2`, and Apple M5. Each run used a new temporary profile with extensions disabled.

| Mode        | Average GPU utilization |
| ----------- | ----------------------: |
| `normal`    |                 `77.7%` |
| `balanced`  |                 `46.9%` |
| `low-power` |                 `24.2%` |
| `software`  |                 `33.9%` |

These measurements identify WebGL and Skia Graphite as major contributors on the tested configuration. They are diagnostic reference values, not performance guarantees for other hardware or releases.

## Upstream fix

The durable fix belongs in the ego lite browser host:

- Stop the browser-owned WebGL overlay when no agent visual effect is active.
- Pause compositor and overlay updates while the window is hidden or occluded.
- Destroy completed animation surfaces instead of leaving a full-window layer attached.
- Clean up stale SharedImage mailboxes rather than retrying compositor submissions.
- Fall back from Skia Graphite on affected macOS and Apple GPU combinations.

Track the existing upstream report in GitHub issue `citrolabs/ego-lite#69`.
