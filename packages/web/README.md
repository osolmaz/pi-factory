# @osolmaz/pi-factory-web

Run a [pi-factory](https://github.com/osolmaz/pi-factory) app in the browser. The page has a session
list on the left and the app's own Pi TUI on the right, in a
[ghostty-web](https://github.com/coder/ghostty-web) terminal. There is no shell and no settings page:
the app decides the model, the extensions, and the theme, exactly as in a normal launch.

```ts
import { runPiWebApp } from "@osolmaz/pi-factory-web";

// `app` is the same PiAppDefinition that runPiApp takes.
process.exitCode = await runPiWebApp(app, { port: 8421 });
```

[localpi](https://github.com/osolmaz/localpi) uses it for `localpi --web`.

## What it does

- **Sessions.** The sidebar lists the sessions Pi stored for the app and the working directory,
  newest first, grouped by day. "New session" starts the app's Pi. Picking a stored session resumes
  it with Pi's `--session` option.
- **One Pi process per open session.** A session keeps running while the server runs, also when no
  browser is attached, so switching sessions is instant. Attaching replays the recent output and
  resizes the PTY, so Pi redraws the screen. Stopping the server stops every session; the sessions
  stay on disk.
- **Status.** The runner adds a small Pi extension to every session. It reports Pi's public events
  to the server, and the sidebar shows a dot: purple while the agent responds, orange while it waits
  for the user (for example a tool approval), none while it is idle. The waiting status needs a Pi
  release that emits `ui_prompt_start` (Pi 0.87 does); an older Pi shows only responding and idle.
  The extension writes nothing to the session except a rename that the page asks for, which it
  applies through `pi.setSessionName`.
- **Fullscreen TUI.** Pi sends mouse clicks to extensions only in its fullscreen mode, so the runner
  adds `--tui-mode fullscreen` unless the app forwards its own `--tui-mode`.

## Options

| Option         | Default                  | Meaning                                                           |
| -------------- | ------------------------ | ----------------------------------------------------------------- |
| `host`         | `127.0.0.1`              | Address to listen on, for example a Tailscale address.            |
| `allowedHosts` | none                     | Extra host names for the page, such as a Tailscale MagicDNS name. |
| `port`         | `0`                      | Port; `0` picks a free port.                                      |
| `open`         | `true`                   | Open the page in the default browser.                             |
| `cwd`          | app root or current dir  | Working directory for new sessions and for the session list.      |
| `theme`        | Catppuccin Latte         | Page and terminal colors.                                         |
| `onReady`      | prints the URL to stderr | Called with the page URL.                                         |

`runPiWebApp` serves until the process gets SIGINT or SIGTERM and returns an exit code.
`startPiWebApp` returns a handle with the URL and `close()`, for tests and embedding.

## Security

- Every page load, API call, and WebSocket needs the random token in the page URL.
- WebSockets must come from the page itself: the `Origin` must match the `Host`.
- The server answers only to loopback names, the host it listens on, and `allowedHosts`, which also
  blocks DNS rebinding.
- Status updates use a second token that only the Pi processes get.

Anyone with the URL can use the agent, and the agent can run commands on the machine. Keep the URL
private, and listen only on loopback or on a private network such as Tailscale.

## Terminal notes

ghostty-web runs Ghostty's terminal core as WebAssembly. The page works around two gaps in the
pinned version:

- It has no Kitty keyboard protocol, so it sends `Ctrl+Shift+letter` as plain `Ctrl+letter`. The
  page encodes these keys as Kitty sequences itself, which Pi reads. This makes keys such as
  localpi's `Ctrl+Shift+S` work.
- It turns the mouse wheel into arrow keys even when the program asked for mouse reports. The page
  reports the wheel as SGR mouse events while mouse tracking is on, so Pi's transcript scrolls.

Browsers keep some keys for themselves, such as `Ctrl+W` and `Ctrl+T`. Those never reach Pi.

## Development

This package lives in the pi-factory repository at `packages/web/` and depends on the published
`@osolmaz/pi-factory`. `npm run check` runs formatting, lint, both typechecks, the build, the tests,
coverage, and the DRY check. The tests start a fake Pi command in a real PTY and never load a model.
