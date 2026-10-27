// Follow the focused herdr pane: show the pane's git root as an extra workspace folder.
const vscode = require('vscode');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// The folder this extension manages is recognised by its name, so it survives extension host restarts.
const MARK = 'herdr: ';

let sock, retry, out, disposed = false;
let pending, running = false;

function cfg(key) {
  return vscode.workspace.getConfiguration('herdrFollow').get(key);
}

function log(line) {
  out.appendLine(line);
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

function processTable() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm='], { maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.split('\n')
        .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] })));
    });
  });
}

// True when a herdr process descends from one of the given pids.
function treeHasHerdr(table, rootPids) {
  const children = new Map();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const stack = [...rootPids];
  while (stack.length) {
    for (const child of children.get(stack.pop()) || []) {
      if (path.basename(child.comm) === 'herdr') return true;
      stack.push(child.pid);
    }
  }
  return false;
}

// A window follows herdr only if herdr runs in one of its own integrated terminals,
// so unrelated windows keep their folders.
async function hostsHerdr() {
  if (cfg('scope') === 'all-windows') return true;
  const pids = (await Promise.all(vscode.window.terminals.map((t) => t.processId))).filter(Boolean);
  return pids.length > 0 && treeHasHerdr(await processTable(), pids);
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

// VS Code rejects a folder update while another is in flight, so wait for each to land.
function foldersChanged() {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); sub.dispose(); resolve(); };
    const timer = setTimeout(done, 2000);
    const sub = vscode.workspace.onDidChangeWorkspaceFolders(done);
  });
}

async function apply(paneId) {
  if (!(await hostsHerdr())) return;
  const { pane } = await request('pane.get', { pane_id: paneId });
  const cwd = pane.foreground_cwd || pane.cwd;
  if (!cwd) return;
  const root = await gitRoot(cwd);

  const folders = vscode.workspace.workspaceFolders || [];
  const managed = folders.findIndex((f) => f.name.startsWith(MARK));
  const own = folders.findIndex((f, i) => i !== managed && f.uri.fsPath === root);
  const entry = { uri: vscode.Uri.file(root), name: `${MARK}${path.basename(path.dirname(root))}/${path.basename(root)}` };

  const changed = foldersChanged();
  let ok;
  if (own >= 0) {
    // The window already has this root as its own folder: drop the stale managed one.
    if (managed < 0) return;
    ok = vscode.workspace.updateWorkspaceFolders(managed, 1);
  } else if (managed >= 0) {
    if (folders[managed].uri.fsPath === root) return;
    ok = vscode.workspace.updateWorkspaceFolders(managed, 1, entry);
  } else {
    ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, entry);
  }
  log(`${paneId} -> ${root}${ok ? '' : ' (update rejected)'}`);
  if (!ok) return;
  await changed;
  if (cfg('revealInExplorer')) vscode.commands.executeCommand('workbench.view.explorer');
}

// Only the latest focus matters: coalesce bursts instead of queueing every pane.
async function follow(paneId) {
  pending = paneId;
  if (running) return;
  running = true;
  try {
    while (pending) {
      const id = pending;
      pending = undefined;
      await apply(id);
    }
  } finally {
    running = false;
  }
}

// Catch up with the pane that is already focused (window start, herdr restart, reconnect).
async function sync() {
  const { snapshot } = await request('session.snapshot', {});
  if (snapshot.focused_pane_id) await follow(snapshot.focused_pane_id);
}

function connect() {
  if (disposed) return;
  let buf = '';
  sock = net.createConnection(socketPath());
  sock.on('connect', () => {
    log(`subscribed on ${socketPath()}`);
    sock.write(JSON.stringify({
      id: 'hf-sub', method: 'events.subscribe',
      params: { subscriptions: [{ type: 'pane.focused' }] },
    }) + '\n');
    sync().catch((e) => log(`sync failed: ${e.message}`));
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
      follow(msg.data.pane_id).catch((e) => log(`follow failed: ${e.message}`));
    }
  });
  // herdr server restarts / updates drop the socket; reconnect until disposed.
  sock.on('close', () => { if (!disposed) retry = setTimeout(connect, 3000); });
  sock.on('error', (e) => log(`socket: ${e.message}`));
}

function activate(context) {
  out = vscode.window.createOutputChannel('herdr follow');
  context.subscriptions.push(out);
  if (!cfg('enabled')) return;
  connect();
  context.subscriptions.push(
    // Restored terminals attach a moment after startup; look again once they have.
    vscode.window.onDidOpenTerminal(() => setTimeout(() => sync().catch((e) => log(`sync failed: ${e.message}`)), 2000)),
    { dispose: deactivate },
  );
}

function deactivate() {
  disposed = true;
  clearTimeout(retry);
  if (sock) sock.destroy();
}

module.exports = { activate, deactivate, follow, treeHasHerdr };
