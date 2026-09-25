---
title: Web mode plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-25
tags: [pi, web, sessions, terminal]
---

# Web mode plan

## Goal

Let a pi-factory app run in the browser with one command, for example `localpi --web`. The user
sees the app's own agent and nothing else: a session list on the left, like Open WebUI, and the
agent's normal Pi TUI in a terminal pane on the right. There is no shell, no settings page, and no
general terminal product. The app decides the model, extensions, and theme, exactly as in a normal
launch.

localpi is the first user. Every pi-factory app can use the same code.

## Selected design

A new package, `@osolmaz/pi-factory-web`, lives in this repository at `packages/web/`. It is pure
TypeScript. It takes the same `PiAppDefinition` that the normal launch uses and serves it in the
browser.

```
┌──────────────┬──────────────────────────────────────┐
│ localpi      │                                      │
│ + New session│   terminal: the Pi TUI for the       │
│              │   selected session                   │
│ ● Fix the... │                                      │
│   Why is ... │                                      │
│ Yesterday    │                                      │
│   Refactor...│                                      │
└──────────────┴──────────────────────────────────────┘
```

### Parts

- **Server (Node).** Serves the browser app on `127.0.0.1`, lists sessions, starts and stops Pi
  processes, and streams each terminal over a WebSocket.
- **Terminal processes.** Each open session is one Pi process in a PTY (`node-pty`), started with the
  app's normal launch plan from the core package. A new session uses the plain launch. An existing
  session adds Pi's `--session <file>` option so Pi resumes it.
- **Session list.** The server reads the app's session directory with Pi's
  `SessionManager.list(cwd, sessionDir)` and shows each session's name or first message and its date,
  grouped by day.
- **Browser app.** A sidebar and a terminal pane. The terminal is `ghostty-web` (Ghostty's terminal
  core compiled to WebAssembly, with an xterm.js-style API), pinned to an exact version and wrapped in
  one small module, so xterm.js can replace it if needed. The theme comes from the app. localpi uses
  Catppuccin Latte in the browser.
- **Status extension.** The runner adds one generated Pi extension to every Pi process it starts. The
  extension reports public Pi events to the server over a per-process channel that the server passes
  in the environment (a local socket path and a random token):
  - `agent_start` → responding
  - `ui_prompt_start` → waiting for the user (for example a tool approval dialog)
  - `ui_prompt_end` → responding again
  - `agent_settled` → idle

  The sidebar shows the status as a dot per session.

### Lifetime

- An open session keeps its Pi process while the server runs, so switching sessions is instant.
- A session that is not open has no process. Opening it resumes it from its session file.
- Closing the browser does not stop the processes. Stopping the server stops them all; the sessions
  stay on disk.

### No Herdr

Herdr is not needed. Pi already stores and resumes sessions, and the status extension replaces
Herdr's agent detection. This keeps the package free of external runtimes and of private Herdr APIs.

## Integration in apps

- The package exports `runPiWebApp(app, options)`. `options` holds only the port, the host, and
  whether to open the browser.
- localpi adds `--web` (and `LOCALPI_WEB`), pins `@osolmaz/pi-factory-web`, and passes the app
  definition it already builds. `--web-port` sets the port.
- The core package stays small. Apps that never use the browser do not install the web package.

## Security

- The server binds to `127.0.0.1` only. It rejects cross-origin WebSocket handshakes and checks a
  random per-run token on every WebSocket, like the ghostty-web demo.
- The status channel checks its own token, so another local process cannot fake a status.
- Remote access, multiple users, and sandboxes are out of scope for this plan.

## Contract impact

- **Session state:** none. The status extension only reads Pi events.
- **Other persistent data:** none. Pi owns the session files.
- **Pi internals:** none. The runner uses the public launch, `SessionManager.list`, and public
  extension events.

## Steps

1. **Spike.** Run the server with a fixed Pi command in one ghostty-web pane, and check the Pi TUI
   in the browser: typing, `Ctrl+Shift` keys, mouse clicks and scrolling in Pi's fullscreen mode,
   resizing, and colors. Compare with xterm.js if a check fails. This is the largest risk, so it
   comes first.
2. **Package.** Create `packages/web/` as an npm workspace with the server, the browser app, the
   launch integration with the core, and tests with a fake Pi command, following this repository's
   testing rules.
3. **Sessions.** The sidebar, new session, and resume.
4. **Status.** The generated extension and the status dots.
5. **localpi.** `--web`, `LOCALPI_WEB`, `--web-port`, and a Catppuccin Latte theme in localpi's
   palette module.

## Acceptance

- `localpi --web` opens the browser with the session list and a working localpi session.
- A new session and a resumed session both work, and switching keeps each session's state.
- The status dot follows responding, waiting, and idle.
- `npm run check` passes in both repositories, and the tests use fake Pi commands only.

## Open questions

- Whether the browser keyboard reaches Pi well enough: browsers keep keys such as `Ctrl+W` and
  `Ctrl+T`. The spike answers this.
- The default port.
