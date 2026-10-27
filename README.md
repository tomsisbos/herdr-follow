# herdr-follow

A VS Code extension that shows the git worktree of the focused [herdr](https://herdr.dev) pane.

When every agent works in its own worktree and you drive everything from the terminal, the editor stops
showing the code you are looking at. herdr-follow listens for herdr's `pane.focused` events and keeps the
focused pane's git root open as an extra workspace folder, so Explorer, Source Control and Quick Open follow
the pane you are in.

## How it works

1. Subscribes to `pane.focused` on the herdr socket (`~/.config/herdr/herdr.sock`) and catches up with the
   currently focused pane on startup and reconnect (`session.snapshot`).
2. Reads the pane's `foreground_cwd` with `pane.get` and resolves `git rev-parse --show-toplevel`.
3. Adds that root as a folder named `herdr: <repo>/<worktree>`, or replaces the previous one. Folders you
   opened yourself are never touched.

It runs in every window, but a window only follows herdr when herdr runs in one of its own integrated
terminals (found by walking the terminals' process trees). Unrelated windows keep their folders.

It reconnects by itself when the herdr server restarts or updates, and it works in untrusted
(Restricted Mode) workspaces: it only talks to the local herdr socket and runs `git rev-parse`.

### First switch in a window

A single-folder window becomes a multi-root workspace the first time a folder is added. VS Code applies that
with an extension host restart (the extension reconnects at once and finds its folder in place). After that
the window stays multi-root and later switches are instant.

## Install

```sh
make install     # packages with @vscode/vsce and runs code --install-extension
```

The output channel **herdr follow** logs every switch. `make uninstall` removes it.

## Settings

| Setting | Default | |
|---|---|---|
| `herdrFollow.enabled` | `true` | Follow herdr focus. |
| `herdrFollow.scope` | `herdr-terminal` | `herdr-terminal`: only windows that run herdr in a terminal. `all-windows`: every window. |
| `herdrFollow.socketPath` | `~/.config/herdr/herdr.sock` | herdr API socket. |
| `herdrFollow.revealInExplorer` | `false` | Show the Explorer view after each switch. |

## Compatibility

Tested against herdr 0.9.5 (API protocol 22) and VS Code 1.140, on macOS. The extension depends on the
`events.subscribe`, `pane.get` and `session.snapshot` socket methods and the
`{ event, data: { pane_id } }` event envelope. After a herdr upgrade, run:

```sh
make smoke
```

It fakes the `vscode` module, checks the process-tree detection, subscribes to the live server and resolves
the focused pane once. It is read-only and never moves herdr focus.
