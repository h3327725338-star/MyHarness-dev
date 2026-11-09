/*
 * Real-Electron test of the Agent giving files to web pages (Windows). Not part of `node --test`, because it needs an
 * Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir under the user folder>
 *
 * The window is never shown, and every file chooser is opened while the Agent holds the tab (so none can show a window).
 * It covers: a button that makes its own file input and opens its chooser (upload by label), the same inside a
 * cross-origin frame (label found in the frame, and by screenshot point), a file input inside a frame with no target
 * named, the Agent's own click on such a button (the answer says a chooser waits, and an upload with no target fills
 * it), several files into an input that takes several and into a chooser that takes one, a page that empties its input
 * in a capturing change handler, a folder-only input, and a menu button that opens no chooser. It prints a JSON report
 * and exits 1 at any broken invariant.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
if (!profile) {
  console.error('usage: electron electron-file-chooser.e2e.cjs --profile=<dir>');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');

const report = { checks: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  process.stderr.write(`${ok ? 'ok' : 'FAIL'} - ${name}\n`);
  if (!ok) report.failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  return !!ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(60);
  }
  return undefined;
};
const rejects = async (fn, pattern, name) => {
  try {
    const value = await fn();
    check(false, name, { resolved: value });
  } catch (error) {
    check(pattern.test(error.message), name, error.message);
  }
};

// The frame page: a button that makes an input and opens its chooser (as Teams' "Upload from this device" does), and a
// file input of its own. It reports to the page above.
const FRAME = `<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head><body style="margin:0;font:14px sans-serif">
<button id="device" style="position:absolute;left:10px;top:10px">Upload from this device</button>
<input id="frameInput" type="file" style="position:absolute;left:10px;top:60px">
<script>
const tell = (text) => parent.postMessage(text, '*');
device.addEventListener('click', () => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.onchange = () => tell('frame-chooser:' + [...input.files].map((f) => f.name).join(',')); input.click(); });
frameInput.addEventListener('change', () => tell('frame-input:' + [...frameInput.files].map((f) => f.name).join(',')));
</script></body></html>`;

const PAGE = (framePort) => `<!doctype html><html><head><meta charset="utf-8"><title>Uploads</title></head><body style="margin:0;font:14px sans-serif">
<button id="attach" style="position:absolute;left:20px;top:20px">Attach a file</button>
<button id="menu" style="position:absolute;left:20px;top:60px">Open attach menu</button>
<input id="many" type="file" multiple style="position:absolute;left:300px;top:20px">
<input id="clearing" type="file" accept="image/*" hidden>
<input id="folder" type="file" webkitdirectory style="position:absolute;left:300px;top:60px">
<div id="log" style="position:absolute;left:20px;top:120px"></div>
<iframe id="frame" src="http://localhost:${framePort}/frame" style="position:absolute;left:100px;top:300px;width:420px;height:200px;border:2px solid #888"></iframe>
<script>
const lines = [];
const add = (text) => { lines.push(text); document.getElementById('log').textContent = lines.join('|'); };
addEventListener('message', (event) => add(String(event.data)));
// One file at a time, made on the click (Gmail's paperclip, chat apps).
attach.addEventListener('click', () => { const input = document.createElement('input'); input.type = 'file'; input.onchange = () => add('attach:' + [...input.files].map((f) => f.name).join(',')); input.click(); });
menu.addEventListener('click', () => add('menu-opened'));
many.addEventListener('change', () => add('many:' + [...many.files].map((f) => f.name).join(',')));
// Like an image search page: the file is taken and the input emptied before anything else hears of it.
window.addEventListener('change', (event) => { if (event.target.id !== 'clearing') return; add('clearing:' + event.target.files.length); event.target.value = ''; }, true);
</script></body></html>`;

async function main() {
  const listen = (handler) => new Promise((resolve, reject) => { const server = http.createServer(handler); server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); });
  const html = (text) => (request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(text); };
  const frameServer = await listen(html(FRAME));
  const framePort = frameServer.address().port;
  const pageServer = await listen(html(PAGE(framePort)));
  const origin = `http://127.0.0.1:${pageServer.address().port}`;

  const chat = join(profile, 'chat');
  mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, 'one.pdf'), '%PDF-1.4 one\n');
  writeFileSync(join(chat, 'two.png'), 'png');
  const elsewhere = join(profile, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'three.txt'), 'three');
  const roots = [chat];

  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const run = (command) => browser.command(command, { agent: true });
  const pageLog = async () => (await run({ action: 'exec', tabId: 't', code: "document.getElementById('log').textContent" })).result || '';
  const logHas = (text) => until(async () => (await pageLog()).includes(text));

  await run({ action: 'ensure', tabId: 't', url: `${origin}/` });
  check(await until(async () => { const state = await run({ action: 'state', tabId: 't' }); return state.loading === false && state.title === 'Uploads'; }), 'the page loads');
  await wait(800);

  // --- a button that opens the page's chooser --------------------------------------------------------------------------
  const byLabel = await run({ action: 'upload', tabId: 't', label: 'Attach a file', path: 'one.pdf', roots });
  check(byLabel.ok && byLabel.how === 'chooser' && byLabel.name === 'one.pdf', 'a button found by its words opens the chooser and the file answers it', byLabel);
  check(await logHas('attach:one.pdf'), 'the page received the file from its own chooser', await pageLog());

  // --- the same inside a cross-origin frame ----------------------------------------------------------------------------
  const inFrame = await run({ action: 'upload', tabId: 't', label: 'Upload from this device', paths: ['one.pdf', 'two.png'], roots });
  check(inFrame.ok && inFrame.how === 'chooser' && inFrame.count === 2 && /localhost/.test(inFrame.frame || ''), 'a button inside a cross-origin frame is found by its words and its chooser takes two files', inFrame);
  check(await logHas('frame-chooser:one.pdf,two.png'), 'the frame received both files', await pageLog());
  // By the point of a screenshot: the frame is at (102, 302) inside its border, the button about 10 px in.
  const byPoint = await run({ action: 'upload', tabId: 't', x: 140, y: 322, path: join(elsewhere, 'three.txt'), roots });
  check(byPoint.ok && byPoint.how === 'chooser', "a point from a screenshot presses the frame's button; a file elsewhere in the user's folder is allowed", byPoint);
  check(await logHas('frame-chooser:three.txt'), 'the frame received the file pressed by point', await pageLog());

  // --- the Agent's own click, then an upload without a target -------------------------------------------------------
  const clicked = await run({ action: 'click', tabId: 't', label: 'Attach a file' });
  check(clicked.ok && clicked.fileChooser && clicked.fileChooser.multiple === false, "the Agent's click reports the chooser it opened (no window)", clicked);
  const pending = await run({ action: 'upload', tabId: 't', path: 'two.png', roots });
  check(pending.ok && pending.how === 'chooser', 'an upload without a target answers the chooser that is waiting', pending);
  check(await logHas('attach:two.png'), 'the page received the file through the waiting chooser', await pageLog());
  const viaMouse = await run({ action: 'mouse', tabId: 't', kind: 'click', x: 140, y: 322 });
  check(viaMouse.ok && viaMouse.fileChooser && viaMouse.fileChooser.frame && /localhost/.test(viaMouse.fileChooser.frame), "a mouse click in the frame reports the frame's chooser", viaMouse);
  const answered = await run({ action: 'upload', tabId: 't', path: 'one.pdf', roots });
  check(answered.ok && answered.how === 'chooser', "the frame's waiting chooser is answered without a target", answered);
  check(await until(async () => /frame-chooser:one\.pdf(\||$)/.test(await pageLog())), 'the frame received the file for the waiting chooser', await pageLog());

  // --- file inputs ------------------------------------------------------------------------------------------------------
  const many = await run({ action: 'upload', tabId: 't', selector: '#many', paths: ['one.pdf', 'two.png'], roots });
  check(many.ok && many.how === 'input' && many.count === 2, 'an input that takes several files gets both', many);
  check(await logHas('many:one.pdf,two.png'), 'the page saw both files in its input', await pageLog());
  const clearing = await run({ action: 'upload', tabId: 't', selector: '#clearing', path: 'two.png', roots });
  check(clearing.ok && clearing.count === 1, 'a page that empties its input before anyone else hears of it still counts as received', clearing);
  check(await logHas('clearing:1'), 'that page took the file once', await pageLog());
  await rejects(() => run({ action: 'upload', tabId: 't', selector: '#folder', path: 'one.pdf', roots }), /文件夹/, 'a folder-only input is refused with the reason');
  await rejects(() => run({ action: 'upload', tabId: 't', label: 'Attach a file', paths: ['one.pdf', 'two.png'], roots }), /一次只收一个文件/, 'two files for a one-file chooser are refused with the reason');
  // The chooser that one opened is still waiting; the next upload without a target answers it.
  const leftOver = await run({ action: 'upload', tabId: 't', path: 'one.pdf', roots });
  check(leftOver.ok && leftOver.how === 'chooser', 'the chooser left waiting by a refused upload is answered by the next one', leftOver);

  // No target and no waiting chooser: the page's own file input. A selector the page does not have is looked for in frames.
  const anyInput = await run({ action: 'upload', tabId: 't', path: 'two.png', roots });
  check(anyInput.ok && anyInput.how === 'input', 'with no target and no waiting chooser, a file input of the page is used', anyInput);
  const frameInput = await run({ action: 'upload', tabId: 't', selector: '#frameInput', path: 'one.pdf', roots });
  check(frameInput.ok && frameInput.how === 'input' && /localhost/.test(frameInput.frame || ''), 'a selector of a file input inside a cross-origin frame is found there', frameInput);
  check(await logHas('frame-input:one.pdf'), "the frame's input received the file", await pageLog());

  // --- a menu button that opens no chooser --------------------------------------------------------------------------
  await rejects(() => run({ action: 'upload', tabId: 't', label: 'Open attach menu', path: 'one.pdf', roots }), /没有打开选择文件的窗口/, 'a button that opens a menu instead of a chooser says what to do next');
  await rejects(() => run({ action: 'upload', tabId: 't', label: 'Nothing reads this', path: 'one.pdf', roots }), /nothing visible on the page reads/, 'a label found nowhere (page or frames) is an error');

  // --- a person's own input gives the choosers back at once -----------------------------------------------------------
  const tab = browser.tabs.find((entry) => entry.id === 't');
  check(!!tab?.chooserGuard, "while the Agent works on the tab, its choosers are taken over", { guard: !!tab?.chooserGuard });
  await wait(1700);
  const contents = tab.view.webContents;
  contents.sendInputEvent({ type: 'mouseDown', x: 700, y: 700, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x: 700, y: 700, button: 'left', clickCount: 1 });
  check(await until(() => tab.chooserGuard === null, 3000), "a person's click in the page ends the takeover, so their own upload buttons open the system window", { guard: !!tab.chooserGuard });
  check(await until(() => (tab.debuggerUsers || 0) === 0, 3000), 'the takeover lets go of the page debugger', { users: tab.debuggerUsers });

  await run({ action: 'close', tabId: '*' });
  frameServer.close();
  pageServer.close();
  report.passed = report.failures.length === 0;
}

setTimeout(() => {
  report.failures.push('watchdog: the run did not finish within 120 s');
  console.log(JSON.stringify(report, null, 1));
  app.exit(1);
}, 120000).unref();

app.whenReady()
  .then(main)
  .catch((error) => { report.failures.push(`crash: ${error.stack || error.message}`); })
  .finally(() => {
    console.log(JSON.stringify(report, null, 1));
    app.exit(report.failures.length === 0 && report.passed ? 0 : 1);
  });
