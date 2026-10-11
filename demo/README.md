# Demo

A test plugin that exercises every corona plugin API in one place. It is written in TypeScript; corona erases the types when it loads the plugin.

## Setup

1. Enable the plugin and add the widget `demo:demo` to a bar.
2. Click the widget to open the panel `demo:main` (520×640).

The widget shows the service's heartbeat, e.g. `Demo ♥ 12`. The count goes up once per second while the **Heartbeat** setting is on.

System services:

| Service | Needed for | Without it |
|---|---|---|
| Corona's notification server | Notify, Rich notify | Always there while corona runs. |
| Secret Service (gnome-keyring, KeePassXC, …) | Secret round trip | The button shows an error. |
| `kdeconnectd` | D-Bus | Optional. `kdeconnect: false`, `devices: null`. |
| `tailscaled` at `/run/tailscale/tailscaled.sock` | Tailscale | Optional. `available: false` with the connect error. |
| Internet access to `example.com` | Fetch | The button shows the network error. |
| A browser | OAuth loopback | `openUri` fails or the call times out after 60 s. |
| logind | Sleep line | `Sleeping: false`, no events. |

## Features

| Feature | API | File | How to test | What to expect |
|---|---|---|---|---|
| Background service | `service = "service.ts"`, `export default async function main(cx)`, `nextCall`/`reply`/`fail` | `service.ts` | Runs whenever the plugin is enabled. | The heartbeat counts up even while the panel is closed. |
| Timer + shared state | `cx.timer.every`, `setState`/`getState` | `service.ts`, `widget.ts`, `panel.ts` | Look at the widget. Turn **Heartbeat** off in the settings. | The counter stops while the setting is off and resumes after. |
| CLI IPC | `corona ipc plugin` | `service.ts` | `corona ipc plugin demo ping` and `corona ipc plugin demo time` | `{"pong":true,"at":"…","greeting":"Hello"}` and `"2026-10-10 11:31:36 CEST"`. `corona ipc plugin demo nope` fails with `unknown method nope`. |
| View → service RPC | `call(method)` from `corona/plugin` | `panel.ts` | Click any button in **Service calls**. | The result appears under **Results**; errors start with `✗`. |
| `process.run` | `run("date", …)`, `fs.execute = ["sh", "date"]`, `process.env = ["PATH", "HOME"]` | `service.ts` (`time`) | **Time (date)** | The current date. Children get the host's `PATH`; a script cannot set its own. |
| `process.spawn` | `spawn`, `readLine`, `readErrLine`, `wait` | `service.ts` (`spawn`) | **Spawn sh loop** | It answers `{pid}` right away. **Spawned process** then fills with `HOME=/home/…` and `line 1` … `line 5`, one line per second. It ends with `exit 3 bye` (exit code and the stderr line). A second click while it runs fails with "still running". |
| Notifications with actions | `notify({summary, body, icon, actions, urgency})`, `nextAction()` | `service.ts` (`notify`) | **Notify**, then click Open/Yes/No on the notification. The **Notification urgency** setting picks the urgency. | **Notification action** shows "waiting for a click", then `picked yes`. The call answers `{id, key}`. If you click after 30 s, the call times out but the state still updates. |
| D-Bus calls | `nameHasOwner`, `call`, `getProperty` | `service.ts` (`dbus`) | **D-Bus** with kdeconnectd running. | `kdeconnect: true` and `devices: [{id, name}]`. `org.freedesktop.Notifications` cannot be granted: corona owns it, notifications go through `corona/notifications`. |
| D-Bus signals | `subscribe`, `nextSignal` | `service.ts` (`watch`) | With KDE Connect, change the phone's battery or connection. | **D-Bus signals** lists the KDE Connect signals, newest first. |
| Unix sockets | `net.connect({ path })`, `network.unix` | `service.ts` (`tailscale`) | **Tailscale** | `{available: true, status: "HTTP/1.0 200 OK", backend: "Running", host, ips, peers}`. Without tailscaled: `{available: false, error}`. A non-200 answer (e.g. 403) is shown with the start of its body. |
| Fetch | `fetch(url, {timeout})`, `arrayBuffer()`, `fetch(url, {stream: true})`, `read()`, `close()` | `service.ts` (`fetch`) | **Fetch** | `{status: 200, bytes: 577, streamStatus: 200, chunks: 1, streamed: 577}`. The sizes may vary. |
| Secrets | `corona/secrets` `set`/`get`/`remove` | `service.ts` (`secret`) | **Secret round trip** | `{matches: true, afterRemove: null}`. The keyring may ask to unlock. |
| Desktop | `pickFiles` (in the service, with `closePanel`/`openPanel`), `openPath`, `openUri` | `service.ts` (`pick`), `panel.ts` | **Pick files**: the panel closes, the file dialog opens, and the panel comes back after picking. Then **Open picked file**. Also try **Open example.com**. | **Picked** lists the paths (kept in shared state). The file opens in its default app, and the browser opens example.com. The service picks because the dialog is a normal window below the panel's layer, and a closed panel's pending promises are dropped. |
| Clipboard | `cx.write_to_clipboard`, `clipboard.write` | `panel.ts` | **Copy results** | The results JSON is on the clipboard. |
| Images | `image("assets/gradient.png")`, `image(Uint8Array)` via `fs/promises` `readFile` under `fs.read = ["${pluginDir}"]` | `panel.ts` | Open the panel. | Two identical gradient squares next to the title. |
| i18n | `corona/i18n` `t(key, {var})`, `language()`, `locales/app.yml` (`_version: 2`, en + de) | all views, `service.ts` | Set the shell language to `de`. | Every label and the notification switch to German. The panel shows the shell language. |
| Settings | `corona/settings` `get`/`all`, typed from `plugin.toml` | `service.ts`, `panel.ts` | Change **Greeting**, **Heartbeat** or **Notification urgency**. | The panel re-renders, and `ping` and the notification use the new greeting. |
| Panel toggle | `corona/surface` `togglePanel`/`isPanelOpen` | `widget.ts` | Click the widget. | The panel opens and closes. The widget is highlighted while the panel is open. |
| Rich notification + inline reply | `notify({body, image, actions, reply, timeout})` with markup, `image` a PNG's bytes from `readFile`, `nextAction()` text | `service.ts` (`richNotify`) | **Rich notify**, then type in the popup's reply field and press Enter, or click **Open**. | A popup with the gradient picture, bold/italic text and a link. The countdown pauses while typing. The call answers `{id, key: "inline-reply", text}` or `{id, key: "open", text: null}`; **Notification action** shows the same. |
| D-Bus overloads | `call` without `signature` picks by argument count | `service.ts` (`dbus`) | **D-Bus** with kdeconnectd running. | `devices` resolves to the 2-argument overload; no "overloaded" error. |
| Binary socket write | `socket.write(Uint8Array)` | `service.ts` (`tailscale`) | **Tailscale** | Same answer as before; the request now goes out as bytes. |
| Child stdin close | `child.write(Uint8Array)`, `closeStdin()` | `service.ts` (`stdin`) | **Stdin + closeStdin** | `{lines: ["got first", "got second", "eof after 2 lines"], code: 0}`. |
| Graceful kill | SIGTERM, SIGKILL after 2 s when the owner goes away | `service.ts` (`spawn`) | **Spawn sh loop**, then disable the plugin within 5 s. | The `sh` loop is gone (`pgrep -f 'line \$i'` finds nothing). |
| File handles | `fs/promises` `open(path, "w" \| "a" \| "r+")`, `read(n)`, `write`, `close`; `fs.write = ["${dataDir}"]` | `service.ts` (`files`) | **File handle** | `{bytes: 19, pieces: 5, text: "hello …␀… appended"}`; the file is in the plugin's data dir. |
| Fetch over a unix socket | `fetch(url, { unix })`, `{ unix, stream: true }` | `service.ts` (`unixFetch`, `ipnBus`) | **Fetch over unix socket**, **Tailscale IPN stream** (tailscaled running) | `{status: 200, backend: "Running", host}` and `{status: 200, state: 6}` (6 = Running). Without tailscaled: the connect error. |
| Settings write + dynamic select | `settings.set`, `setOptions`, `dynamic = true` | `service.ts` (`settings`, `main`) | **Next favorite (settings.set)**; open the plugin's settings. | **Favorite** steps none → tea → coffee → water; the settings app's dropdown lists the service's options and follows. |
| Secret setting | `type = "secret"`, `secrets.get("token")` | `plugin.toml`, `service.ts` (`secretSetting`) | Enter a token in the plugin's settings (Enter stores it), then **Read token setting**. Delete it with the button. | `{set: true, length: N}`, then `{set: false}`. The value is never in `config.toml`. |
| Sleep / resume | `corona/power` `sleeping()`, `resumedAt()`, `nextSleepEvent()` | `panel.ts`, `service.ts` (`sleepEvents`) | `systemctl suspend`, wake up, open the panel. | **Sleeping: false · last resume: <time> · service saw: resumed at <time>**. |
| OAuth loopback | `listenRedirect`, `openUri`, `nextRedirect` | `service.ts` (`oauth`) | **OAuth loopback** | The browser shows "You can close this tab."; the result is `{port, path: "/callback", query: {code: "demo-…", state: "a b"}}`. |
| TypeScript | `.ts` views/service, `import type`, `./util.ts` import | all | — | It loads; no build step. |

## Editor

When it loads the plugin, corona writes `gpui-kit.d.ts` and, if there is none yet, `jsconfig.json` into this directory. Both are gitignored. The jsconfig enables `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`, so only erasable TypeScript passes: no enums, namespaces or parameter properties, and types are imported with `import type`. To check the plugin:

```sh
tsc -p jsconfig.json
```
