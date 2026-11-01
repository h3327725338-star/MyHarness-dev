const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BUNDLED_EXTENSIONS, bundledExtensionArgs } = require('../bundled-extensions.cjs');

test('a bundled extension loads unless the user keeps their own copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-extensions-'));
  try {
    const app = path.join(dir, 'app');
    const agent = path.join(dir, 'agent');
    assert.deepEqual(bundledExtensionArgs(app, agent), [], 'nothing to load when the file is not there');
    const bundled = path.join(app, 'runtime', 'extensions', BUNDLED_EXTENSIONS[0]);
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, '');
    assert.deepEqual(bundledExtensionArgs(app, agent), ['--extension', bundled]);
    const own = path.join(agent, 'extensions', BUNDLED_EXTENSIONS[0]);
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, '');
    assert.deepEqual(bundledExtensionArgs(app, agent), [], 'the copy in the extensions folder is already loaded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the build copies each bundled extension into the packaged app', () => {
  const root = path.join(__dirname, '../../..');
  for (const name of BUNDLED_EXTENSIONS) assert.ok(fs.existsSync(path.join(root, 'packages/coding-agent/examples/extensions', name)), `${name} has no source`);
  const build = fs.readFileSync(path.join(__dirname, '../build.mjs'), 'utf8');
  assert.match(build, /BUNDLED_EXTENSIONS/);
  assert.match(build, /to: 'resources\/app\/runtime\/extensions'/);
});
