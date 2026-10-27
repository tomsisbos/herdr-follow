// Smoke test against the live herdr server, with the vscode module faked.
// Read-only: it never changes herdr focus. Exits non-zero on failure.
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const log = [];
const folders = [{ uri: { fsPath: '/home/me/own-project' }, name: 'own-project' }];
const updates = [];
let onChange = () => {};
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ enabled: true, scope: 'all-windows' })[k] }),
    get workspaceFolders() { return folders; },
    onDidChangeWorkspaceFolders: (fn) => { onChange = fn; return { dispose() {} }; },
    updateWorkspaceFolders: (start, del, ...add) => {
      updates.push([start, del, ...add]);
      folders.splice(start, del, ...add);
      setImmediate(() => onChange());
      return true;
    },
  },
  window: {
    terminals: [],
    createOutputChannel: () => ({ appendLine: (l) => { log.push(l); console.log('[out]', l); }, dispose() {} }),
    onDidOpenTerminal: () => ({ dispose() {} }),
  },
  commands: { executeCommand() {} },
  Uri: { file: (p) => ({ fsPath: p }) },
};
const load = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));

// Process-tree detection, shaped like the real layout: Code > zsh > herdr > herdr server.
const table = [
  { pid: 1, ppid: 0, comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' },
  { pid: 10, ppid: 1, comm: '/bin/zsh' },
  { pid: 11, ppid: 10, comm: 'herdr' },
  { pid: 12, ppid: 11, comm: '/opt/homebrew/bin/herdr' },
  { pid: 20, ppid: 1, comm: '/bin/zsh' },
  { pid: 21, ppid: 20, comm: 'vim' },
];
assert.strictEqual(ext.treeHasHerdr(table, [10]), true, 'terminal running herdr');
assert.strictEqual(ext.treeHasHerdr(table, [20]), false, 'terminal without herdr');
assert.strictEqual(ext.treeHasHerdr(table, [10, 20]), true, 'any terminal counts');
console.log('process-tree detection OK');

(async () => {
  const { snapshot } = JSON.parse(execFileSync('herdr', ['api', 'snapshot'])).result;
  console.log(`herdr ${snapshot.version}, protocol ${snapshot.protocol}, focused pane ${snapshot.focused_pane_id}`);

  ext.activate({ subscriptions: [] });
  await new Promise((r) => setTimeout(r, 800)); // connect + startup sync
  assert(log.some((l) => l.startsWith('subscribed')), 'subscription did not start');
  assert.strictEqual(updates.length, 1, `startup sync: expected 1 folder update, got ${updates.length}`);
  const [start, del, entry] = updates[0];
  assert.strictEqual(start, 1, 'must append after the window\'s own folder');
  assert.strictEqual(del, 0);
  assert(entry.name.startsWith('herdr: '), 'managed folder must carry the marker');
  assert.strictEqual(folders[0].name, 'own-project', 'own folder untouched');

  await ext.follow(snapshot.focused_pane_id); // same pane again: nothing to do
  assert.strictEqual(updates.length, 1, 'repeat focus must be a no-op');
  console.log('folder update:', JSON.stringify(updates[0]));
})().then(() => { ext.deactivate(); console.log('OK'); process.exit(0); },
  (e) => { ext.deactivate(); console.log(`FAIL: ${e.message}`); process.exit(1); });
