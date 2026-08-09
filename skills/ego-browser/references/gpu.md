# macOS GPU compatibility modes

Use this guide when ego lite causes sustained GPU activity while its window is visible.

This repository contains the open-source `ego-browser` automation runtime and Skill, not the browser application's Chromium host source. The integrations below are therefore opt-in compatibility workarounds while the browser-side compositor issue is fixed upstream.

## Switch modes inside ego lite

The optional GPU controller adds a toolbar popup to ego lite and uses a restricted native messaging host to persist the selected mode and restart the browser.

```bash
sh skills/ego-browser/gpu-controller/install.sh
```

Complete the one-time unpacked-extension step shown by the installer, then pin **ego GPU Mode** from the extensions menu. Later mode changes happen entirely from that popup. Applying a mode restarts ego lite and ends active Agent tasks.

The controller does not edit or re-sign the ego lite application. Balanced mode is persisted through Chromium's tested `skia-graphite@5` Local State experiment, which produces `--disable-features=SkiaGraphite` during a normal launch. Low-power mode runs a small local watchdog that hides ego lite after it loses focus; clicking the Dock icon restores the browser.

See [`gpu-controller/README.md`](../gpu-controller/README.md) for installation and security details.

## Launch a compatibility mode

Quit ego lite completely before running the launcher. Closing its windows is not enough because Chromium graphics flags only apply when the browser process starts.

```bash
sh skills/ego-browser/scripts/launch-gpu-mode.sh balanced
```

Available modes:

| Mode        | Behavior                          | Trade-off                                                                                     |
| ----------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `normal`    | No graphics override              | Normal ego lite behavior                                                                      |
| `balanced`  | Disables Skia Graphite            | Keeps WebGL available but falls back from the Graphite renderer                               |
| `low-power` | Hides ego lite after focus is lost | The browser is restored from its Dock icon; screen-based effects may pause while it is hidden |
| `software`  | Disables GPU acceleration         | Blocked on ego lite `0.4.6.12` because that build exits during startup                        |

The standalone script refuses to launch if ego lite is already running. It does not edit the browser profile, Chrome flags preferences, bookmarks, cookies, or extensions.

To return to the default behavior, quit ego lite and open it normally from Finder, Spotlight, or the Dock.

## Reference measurements

The following foreground-visibility comparison was recorded on August 9, 2026 with ego lite `0.4.6.12`, Chromium `150.0.7871.101`, macOS `26.5.2`, and Apple M5. It used the real browser profile and the same five-sample `powermetrics` method for each application.

| Visible application | Average GPU utilization |
| ------------------- | ----------------------: |
| ego lite            |                 `71.73%` |
| ChatGPT             |                 `19.90%` |
| QuarkCloudDrive     |                 `18.88%` |
| Google Chrome       |                  `8.55%` |
| Clean desktop       |                  `8.54%` |

A separate 12-sample run with `--disable-webgl` still averaged `76.57%`. Disabling GPU compositing and rasterization also made no material difference. Both `--disable-gpu` and Chromium's persistent hardware-acceleration-off preference caused ego lite `0.4.6.12` to exit with `SIGTRAP`.

After enabling the low-power watchdog, a 12-sample hidden-window run averaged `9.72%` GPU utilization with a range of `8.14%` to `11.62%`. These results locate the sustained load in the browser-owned visible-window rendering path. Hiding ego lite is the only tested workaround that lowers the load reliably without crashing this build.

## Upstream fix

The durable fix belongs in the closed-source ego lite browser host rather than this open-source automation harness:

- Stop the browser-owned WebGL overlay when no agent visual effect is active.
- Pause compositor and overlay updates while the window is hidden or occluded.
- Destroy completed animation surfaces instead of leaving a full-window layer attached.
- Clean up stale SharedImage mailboxes rather than retrying compositor submissions.
- Fall back from Skia Graphite on affected macOS and Apple GPU combinations.

Track the existing upstream report in GitHub issue `citrolabs/ego-lite#69`.
