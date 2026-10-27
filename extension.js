// Follow the focused herdr pane: keep the pane's git root as a workspace folder.
const vscode = require('vscode');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let sock, retry, out, lastError, disposed = false;
// Latest focus wins: `seq` drops stale lookups, `wanted` is applied once no update is pending.
let seq = 0, wanted, pending = false;

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
    c.setEncoding('utf8');
    c.setTimeout(5000, () => c.destroy(new Error(`${method} timed out`)));
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ id: 'hf', method, params }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      c.end();
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { return reject(e); }
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    });
    c.on('error', reject);
    // A promise settles once, so this only fires when no reply line arrived.
    c.on('close', () => reject(new Error(`${method}: connection closed without a reply`)));
  });
}

async function follow(paneId) {
  const mine = ++seq;
  const { pane } = await request('pane.get', { pane_id: paneId });
  const cwd = pane.foreground_cwd || pane.cwd;
  if (!cwd) return;
  const root = await gitRoot(cwd);
  if (mine !== seq) return;
  wanted = { paneId, root };
  apply();
}

// VS Code rejects updateWorkspaceFolders while a previous update is still pending,
// so apply one at a time and retry `wanted` from onDidChangeWorkspaceFolders.
function apply() {
  if (pending || !wanted) return;
  const { paneId, root } = wanted;
  // Index 0 is a fixed anchor: replacing the first folder restarts the extension host.
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 2 && folders[1].uri.fsPath === root) return;
  const ok = vscode.workspace.updateWorkspaceFolders(1, Math.max(folders.length - 1, 0),
    { uri: vscode.Uri.file(root), name: path.basename(path.dirname(root)) + '/' + path.basename(root) });
  pending = ok;
  out.appendLine(`${paneId} -> ${root}${ok ? '' : ' (update rejected)'}`);
  if (ok && cfg('revealInExplorer')) vscode.commands.executeCommand('workbench.view.explorer');
}

function connect() {
  if (disposed) return;
  let buf = '';
  sock = net.createConnection(socketPath());
  sock.setEncoding('utf8');
  sock.on('connect', () => {
    lastError = undefined;
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
  // Log each distinct error once instead of every retry while herdr is down.
  sock.on('error', (e) => {
    if (e.message !== lastError) out.appendLine(`socket: ${e.message} (retrying every 3s)`);
    lastError = e.message;
  });
}

function activate(context) {
  out = vscode.window.createOutputChannel('herdr follow');
  context.subscriptions.push(out);
  if (!cfg('enabled')) return;
  // In a single-folder window, adding a folder converts it to a workspace and reloads it.
  if (!vscode.workspace.workspaceFile) {
    out.appendLine('disabled: open a .code-workspace file (see make workspace)');
    return;
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { pending = false; apply(); }),
    { dispose: deactivate });
  connect();
}

function deactivate() {
  disposed = true;
  clearTimeout(retry);
  if (sock) sock.destroy();
}

module.exports = { activate, deactivate, follow };
