// Windows Electron regression. Run with electron.exe <absolute script path> --profile=<empty directory>.
// Keep windows hidden and bound WebAuthn probes so a regression does not leave a pending request.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { createBrowser } = require('../browser-view.cjs');

const profile = process.argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length);
if (!profile) throw new Error('An isolated --profile directory is required');
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

const probe = `
  const policy = document.featurePolicy;
  const get = policy.allowsFeature('publickey-credentials-get');
  const create = policy.allowsFeature('publickey-credentials-create');
  document.body.dataset.passkeys = [get, create].join(',');
  document.body.dataset.geolocation = policy.allowsFeature('geolocation');
  if ((!get && !create) || location.hash === '#probe') {
    const challenge = new Uint8Array(32);
    (async () => {
      const errors = [];
      for (const request of [
        () => navigator.credentials.get({ publicKey: { challenge }, signal: AbortSignal.timeout(250) }),
        () => navigator.credentials.create({ publicKey: { challenge, rp: { name: 'Test' }, user: { id: challenge, name: 'test', displayName: 'Test' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] }, signal: AbortSignal.timeout(250) }),
      ]) {
        try { await request(); errors.push('unexpected credential'); } catch (error) { errors.push(error.name); }
      }
      document.body.dataset.rejections = errors.join(',');
    })();
  }
`;

async function main() {
  let origins;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: `${origins[1]}/article` }); return res.end(); }
    if (req.url === '/worker.js') {
      const body = `<!doctype html><title>Worker article</title><body><main>Readable article</main><script>${probe}</script></body>`;
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`self.addEventListener('fetch', (event) => {
        if (new URL(event.request.url).pathname === '/worker-article') event.respondWith(new Response(${JSON.stringify(body)}, {
          headers: { 'content-type': 'text/html', 'permissions-policy': 'geolocation=()' },
        }));
      });`);
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'max-age=600',
      'permissions-policy': ['geolocation=()', 'publickey-credentials-get=*, publickey-credentials-create=*'],
    });
    res.end(`<!doctype html><title>Article</title><body><main>Readable article</main><script>${probe}</script></body>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const window = new BrowserWindow({ show: false });
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const run = (command) => browser.command(command, { agent: true });
  const read = async (url, searchPreview) => {
    const start = performance.now();
    const result = await run({ action: 'readUrl', url, html: true, settleMs: 100, searchPreview });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.html, /<main>Readable article<\/main>/);
    assert.match(result.html, /data-geolocation="false"/);
    assert.match(result.html, searchPreview ? /data-passkeys="false,false"/ : /data-passkeys="true,true"/);
    if (searchPreview) assert.match(result.html, /data-rejections="NotAllowedError,NotAllowedError"/);
    return Math.round(performance.now() - start);
  };
  try {
    const results = [];
    for (const origin of origins) {
      const url = `${origin}/article`;
      // Same shared profile and cacheable URL: regular read first, then protected read, then regular read again.
      const regularMs = await read(url, false);
      const searchMs = await read(url, true);
      const regularAfterMs = await read(url, false);
      results.push({ host: new URL(origin).hostname, regularMs, searchMs, regularAfterMs });
    }
    await read(`${origins[0]}/redirect`, true);
    const url = `${origins[1]}/article`;
    await run({ action: 'open', tabId: 'interactive', url });
    let passkeys;
    for (let attempt = 0; attempt < 60 && !passkeys; attempt++) {
      passkeys = (await run({ action: 'exec', tabId: 'interactive', code: 'document.body?.dataset.passkeys ?? null' })).result;
      if (!passkeys) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(passkeys, 'true,true');
    const registration = await run({ action: 'exec', tabId: 'interactive', code: `
      navigator.serviceWorker.register('/worker.js').then(() => navigator.serviceWorker.ready).then(() => 'ready')
    ` });
    assert.equal(registration.result, 'ready');
    // Use localhost rather than an IP literal so the relying-party check does not reject the request first.
    const workerUrl = `${origins[1]}/worker-article`;
    const workerArticle = await run({ action: 'readUrl', url: workerUrl, html: true, settleMs: 100 });
    assert.equal(workerArticle.title, 'Worker article');
    const workerSearch = await run({ action: 'readUrl', url: `${workerUrl}#probe`, html: true, searchPreview: true, settleMs: 800 });
    assert.equal(workerSearch.title, 'Worker article');
    assert.match(workerSearch.html, /<main>Readable article<\/main>/);
    assert.match(workerSearch.html, /data-rejections="(?:NotAllowedError|TimeoutError),(?:NotAllowedError|TimeoutError)"/);
    console.log(JSON.stringify({ passed: true, results, worker: /data-rejections="([^"]+)"/.exec(workerSearch.html)[1] }));
  } finally {
    browser.destroy();
    window.destroy();
    server.close();
  }
}

setTimeout(() => { console.error('Passkey regression timed out'); app.exit(1); }, 30000).unref();
app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
