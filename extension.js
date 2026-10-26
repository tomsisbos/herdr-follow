// Follow the focused herdr pane: keep the pane's git root as a workspace folder.
const vscode = require('vscode');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let sock, retry, out, lastRoot, disposed = false;

function cfg(key) {
  return vscode.workspace.getConfiguration('herdrFollow').get(key);
}

function socketPath() {
  return (cfg('socketPath') || '~/.config/herdr/herdr.sock').replace(/^~/, os.homedir());
}

function gitRoot(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel'], (err, stdout) =>
      resolve(err ? dir : stdout.trim()));
  });
}

// One request per short-lived connection keeps the subscription stream clean.
function request(method, params) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath());
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ id: 'hf', method, params }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      c.end();
      const msg = JSON.parse(buf.slice(0, nl));
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    });
    c.on('error', reject);
  });
}

async function follow(paneId) {
  const { pane } = await request('pane.get', { pane_id: paneId });
  const cwd = pane.foreground_cwd || pane.cwd;
  if (!cwd) return;
  const root = await gitRoot(cwd);
  if (root === lastRoot) return;
  lastRoot = root;

  // Index 0 is a fixed anchor: replacing the first folder restarts the extension host.
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.some((f, i) => i > 0 && f.uri.fsPath === root)) return;
  const ok = vscode.workspace.updateWorkspaceFolders(1, Math.max(folders.length - 1, 0),
    { uri: vscode.Uri.file(root), name: path.basename(path.dirname(root)) + '/' + path.basename(root) });
  out.appendLine(`${paneId} -> ${root}${ok ? '' : ' (update rejected)'}`);
  if (ok && cfg('revealInExplorer')) vscode.commands.executeCommand('workbench.view.explorer');
}

function connect() {
  if (disposed) return;
  let buf = '';
  sock = net.createConnection(socketPath());
  sock.on('connect', () => {
    out.appendLine(`subscribed on ${socketPath()}`);
    sock.write(JSON.stringify({
      id: 'hf-sub', method: 'events.subscribe',
      params: { subscriptions: [{ type: 'pane.focused' }] },
    }) + '\n');
  });
  sock.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // Envelope: { event: "pane_focused", data: { pane_id, workspace_id } }
      if (!msg.data || !msg.data.pane_id) continue;
      follow(msg.data.pane_id).catch((e) => out.appendLine(`follow failed: ${e.message}`));
    }
  });
  // herdr server restarts / updates drop the socket; reconnect until disposed.
  sock.on('close', () => { if (!disposed) retry = setTimeout(connect, 3000); });
  sock.on('error', (e) => out.appendLine(`socket: ${e.message}`));
}

function activate(context) {
  out = vscode.window.createOutputChannel('herdr follow');
  if (!cfg('enabled')) return;
  // In a single-folder window, adding a folder converts it to a workspace and reloads it.
  if (!vscode.workspace.workspaceFile) {
    out.appendLine('disabled: open a .code-workspace file (see make workspace)');
    return;
  }
  connect();
  context.subscriptions.push(out, { dispose: deactivate });
}

function deactivate() {
  disposed = true;
  clearTimeout(retry);
  if (sock) sock.destroy();
}

module.exports = { activate, deactivate, follow };
