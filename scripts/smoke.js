// Smoke test against the live herdr server, with the vscode module faked.
// Subscribes to pane focus events, then resolves the currently focused pane once.
// Read-only: it never changes herdr focus. Exits non-zero on failure.
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');

const calls = [];
const lines = [];
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ enabled: true })[k] }),
    workspaceFolders: [{ uri: { fsPath: '/anchor' } }],
    workspaceFile: { fsPath: '/anchor.code-workspace' },
    updateWorkspaceFolders: (...args) => { calls.push(args); return true; },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  },
  window: { createOutputChannel: () => ({ appendLine: (l) => { lines.push(l); console.log('[out]', l); }, dispose() {} }) },
  commands: { executeCommand() {} },
  Uri: { file: (p) => ({ fsPath: p }) },
};
const load = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest);
};

const { snapshot } = JSON.parse(execFileSync('herdr', ['api', 'snapshot'])).result;
console.log(`herdr ${snapshot.version}, protocol ${snapshot.protocol}, focused pane ${snapshot.focused_pane_id}`);

const ext = require(path.join(__dirname, '..', 'extension.js'));
ext.activate({ subscriptions: [] });

setTimeout(async () => {
  let failure;
  try {
    await ext.follow(snapshot.focused_pane_id);
    if (!lines.some((l) => l.startsWith('subscribed'))) failure = 'subscription did not start';
    else if (calls.length !== 1) failure = `expected 1 folder update, got ${calls.length}`;
    else console.log('folder update:', JSON.stringify(calls[0]));
  } catch (e) {
    failure = e.message;
  }
  ext.deactivate();
  console.log(failure ? `FAIL: ${failure}` : 'OK');
  process.exit(failure ? 1 : 0);
}, 500);
