# herdr-follow

A VS Code extension that shows the git worktree of the focused [herdr](https://herdr.dev) pane.

When every agent works in its own worktree and you drive everything from the terminal, the editor stops
showing the code you are looking at. herdr-follow listens for herdr's `pane.focused` events and swaps the
window's workspace folder to the focused pane's git root, so Explorer, Source Control and Quick Open follow
the pane you are in. Nothing reloads, so a herdr client running in the integrated terminal keeps going.

## How it works

1. Subscribes to `pane.focused` on the herdr socket (`~/.config/herdr/herdr.sock`).
2. On each event, reads the pane's `foreground_cwd` with `pane.get` and resolves `git rev-parse --show-toplevel`.
3. Replaces every workspace folder after the first with that root.

Folder #1 is a fixed anchor: VS Code restarts the extension host whenever the first workspace folder
changes. Open the window on a workspace whose first folder never moves (`make workspace` creates one
anchored on `~/.herdr/worktrees`).

The extension reconnects by itself when the herdr server restarts or updates.

## Install

```sh
make install     # packages with @vscode/vsce and runs code --install-extension
make workspace   # creates ~/.herdr/herdr.code-workspace
code ~/.herdr/herdr.code-workspace
```

Start herdr in that window's terminal. The output channel **herdr follow** logs every switch.

`make uninstall` removes it.

## Settings

| Setting | Default | |
|---|---|---|
| `herdrFollow.enabled` | `true` | Follow herdr focus in this window. Turn it off per window to keep a folder pinned. |
| `herdrFollow.socketPath` | `~/.config/herdr/herdr.sock` | herdr API socket. |
| `herdrFollow.revealInExplorer` | `false` | Show the Explorer view after each switch. |

## Compatibility

Tested against herdr 0.9.5 (API protocol 22) and VS Code 1.140. The extension depends on the
`events.subscribe` / `pane.get` socket methods and the `{ event, data: { pane_id } }` event envelope.
After a herdr upgrade, run:

```sh
make smoke
```

It fakes the `vscode` module, subscribes to the live server and resolves the focused pane once. It is
read-only and never moves herdr focus.
