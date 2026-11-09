/*
 * Real-Electron test of sending an email through the Gmail or Outlook website with no model working the page
 * (browser-web-mail-send.cjs through the browser's `webMailSend` command). Not part of `node --test`, because it needs an
 * Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir>
 *
 * No real website is reached: the tabs' session answers https itself with stand-ins of the two compose pages, shaped
 * like the real ones where the sender looks (Gmail's subjectbox, editable text with a signature, address chips,
 * paperclip that opens a file chooser and shows chips while uploading, "Send (Ctrl-Enter)" button and "View message"
 * link; Outlook's editable recipient field, subject field, message body, "Attach file" menu with "Browse this
 * computer", its "Attach as a copy" question and Send button). The window is never shown.
 * It covers: the address the page is opened at (no text in it), the text typed above the signature, a long text, a send
 * by the real mouse, a form that shows up late, a button that only Ctrl+Enter reaches, a complaint of the website, a
 * sign-in redirect, a form missing the subject or refusing the text, emoji Gmail draws as pictures in the text, a send
 * the website never confirms, attachments through Gmail's chooser, through a form whose button is missing, through
 * Outlook's menu and copy question, attachments that are missing or too large, an attachment the website refuses,
 * Outlook, choosing Gmail by its sign-in cookies, two sends due together going one after the other, and the off-screen
 * pages being closed afterwards. It prints a JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow, session } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
if (!profile) {
  console.error('usage: electron electron-web-mail-send.e2e.cjs --profile=<dir>');
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

// How the stand-in Gmail behaves this time, and what it saw.
let mode = 'ok';
const opened = [];
const sent = [];
const html = (body) => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Gmail</title></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function gmailCompose(params) {
  const bare = (value) => ((/[^\s<>",;]+@[^\s<>",;]+/.exec(value) || [''])[0]).toLowerCase();
  const chips = ['to', 'cc', 'bcc'].flatMap((key) => (params.get(key) || '').split(',')).filter(Boolean).map((value) => `<span email="${escape(bare(value))}" class="chip">${escape(value)}</span>`).join('');
  const subject = mode === 'noSubject' ? '' : params.get('su') || '';
  // Like Gmail: the message box opens with an empty line and the signature under it; the paperclip opens a chooser.
  const attach = mode === 'attachNoButton' ? '' : '<div role="button" command="Files" aria-label="Attach files" data-tooltip="Attach files" id="clip">📎</div><div role="button" aria-label="Insert files using Drive" id="drive">D</div>';
  const spare = mode === 'attachNoButton' ? '<input type="file" multiple name="Filedata" id="spare" style="display:none">' : '';
  const form = `<div class="form"><div class="recipients">${chips}</div>
<input name="subjectbox" value="${escape(subject)}">
<div g_editable="true" contenteditable="true" role="textbox" style="min-height:200px"><div><br></div><div class="gmail_signature">-- Bob Hu</div></div>
<div class="attachments" id="atts"></div>${spare}
<div class="bar"><div role="button" class="T-I aoO" tabindex="1" data-tooltip="Send ‪(Ctrl-Enter)‬" id="send">Send</div>${attach}</div></div>`;
  return html(`<div id="app"></div><script>
const mode = ${JSON.stringify(mode)};
const form = ${JSON.stringify(form)};
window.attached = [];
const done = () => {
  fetch('/sent', { method: 'POST', body: JSON.stringify({ to: [...document.querySelectorAll('[email]')].map((el) => el.getAttribute('email')), subject: document.querySelector('[name=subjectbox]').value, text: document.querySelector('[g_editable]').innerText, attached: window.attached }) });
  if (mode === 'complaint') {
    document.body.insertAdjacentHTML('beforeend', '<div role="alertdialog">The address "nobody@" in the "To" field was not recognized.</div>');
    return;
  }
  document.getElementById('app').innerHTML = '<div>Message sent <span id="link_vsm" role="link">View message</span></div>';
};
const took = async (input) => {
  for (const file of input.files) {
    const text = file.size < 4096 ? await file.text() : '';
    window.attached.push({ name: file.name, size: file.size, text });
    if (mode === 'attachRefused') {
      document.body.insertAdjacentHTML('beforeend', '<div role="alertdialog">Attachment failed. This could be due to a network problem.</div>');
      return;
    }
    const chip = document.createElement('div');
    chip.className = 'dL';
    chip.innerHTML = '<div class="vI"></div><div class="vJ"></div><div role="progressbar" style="width:50px;height:4px;background:#00f"></div>';
    chip.querySelector('.vI').textContent = file.name;
    chip.querySelector('.vJ').textContent = '(' + Math.ceil(file.size / 1024) + 'K)';
    document.getElementById('atts').appendChild(chip);
    setTimeout(() => chip.querySelector('[role=progressbar]')?.remove(), 900);
  }
};
const show = () => {
  document.getElementById('app').innerHTML = form;
  const send = document.getElementById('send');
  const box = document.querySelector('[g_editable]');
  // Like Gmail: the button acts on a trusted press, not on a scripted click(); here only the mouse or Ctrl+Enter.
  if (mode !== 'keysOnly' && mode !== 'silent') send.addEventListener('mouseup', (event) => { if (event.isTrusted) done(); });
  if (mode !== 'silent') box.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key === 'Enter') done(); });
  // A form that refuses what is typed into it; and, like Gmail, emoji turned into pictures as they are typed.
  if (mode === 'noBody') box.addEventListener('input', () => { box.innerHTML = ''; });
  if (mode === 'emoji') box.addEventListener('input', () => {
    const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walk.nextNode(); node; node = walk.nextNode()) nodes.push(node);
    for (const node of nodes) {
      if (!/\\p{Extended_Pictographic}/u.test(node.data)) continue;
      const span = document.createElement('span');
      span.innerHTML = node.data.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\\p{Extended_Pictographic}\\uFE0F?/gu, (found) => '<img data-emoji="' + found.replace(/\\uFE0F/g, '') + '" alt="' + found.replace(/\\uFE0F/g, '') + '" class="an1" src="data:,">');
      node.replaceWith(...span.childNodes);
    }
  });
  const clip = document.getElementById('clip');
  if (clip) clip.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.name = 'Filedata';
    input.addEventListener('change', () => took(input));
    input.click();
  });
  const spare = document.getElementById('spare');
  if (spare) spare.addEventListener('change', () => took(spare));
};
setTimeout(show, mode === 'late' ? 2500 : 50);
</script>`);
}

function outlookCompose(params) {
  // Like Outlook: the recipients sit in an editable box of their own, before the message body.
  const form = `<div class="compose"><div contenteditable="true" aria-label="To" class="well">${escape((params.get('to') || '').split(',').join('; '))}</div>
<input aria-label="Add a subject" value="${escape(params.get('subject') || '')}">
<div contenteditable="true" aria-label="Message body" style="min-height:240px"><div><br></div><div id="Signature">Bob Hu</div></div>
<div id="cards"></div>
<button aria-label="Attach file" title="Attach a file to this item." id="attach">Attach file</button>
<button aria-label="Signature" title="Attach one of your email signatures to this message.">Signature</button>
<button aria-label="Send" title="Send (Ctrl+Enter)" id="send">Send</button></div>`;
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Mail - Bob Hu - Outlook</title></head><body><div id="app">${form}</div><script>
window.attached = [];
document.getElementById('send').addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  fetch('/sent', { method: 'POST', body: JSON.stringify({ outlook: true, subject: document.querySelector('input').value, text: document.querySelector('[aria-label="Message body"]').innerText, recipients: document.querySelector('[aria-label=To]').innerText, attached: window.attached }) });
  document.getElementById('app').innerHTML = '<div>Inbox</div>';
});
document.getElementById('attach').addEventListener('click', () => {
  document.body.insertAdjacentHTML('beforeend', '<div role="menu" id="menu"><div role="menuitem" id="cloud">Cloud locations</div><div role="menuitem" id="browse">Browse this computer</div></div>');
  document.getElementById('browse').addEventListener('click', () => {
    document.getElementById('menu').remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('data-testid', 'local-computer-filein');
    input.addEventListener('change', () => {
      const files = [...input.files];
      // Like Outlook: it asks how to attach before the files show up.
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="ask"><button id="share">Share link</button><button id="copy">Attach as a copy</button></div>');
      document.getElementById('copy').addEventListener('click', () => {
        document.getElementById('ask').remove();
        for (const file of files) {
          window.attached.push({ name: file.name, size: file.size });
          const card = document.createElement('div');
          card.setAttribute('aria-label', file.name);
          card.textContent = file.name;
          document.getElementById('cards').appendChild(card);
        }
      });
    });
    input.click();
  });
});
</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function answer(request) {
  const url = new URL(request.url);
  if (url.pathname === '/sent' && request.method === 'POST') {
    sent.push({ host: url.host, at: Date.now(), ...JSON.parse(await request.text()) });
    return new Response('ok');
  }
  if (url.host === 'mail.google.com' && url.pathname === '/mail/u/0/feed/atom') {
    return new Response('<feed><title>Gmail - Inbox for bob@gmail.com</title></feed>', { headers: { 'content-type': 'application/atom+xml' } });
  }
  if (url.host === 'mail.google.com' && url.pathname === '/mail/') {
    opened.push({ url: request.url, at: Date.now() });
    if (mode === 'signedOut') return Response.redirect('https://accounts.google.com/v3/signin/identifier?continue=gmail', 302);
    return gmailCompose(url.searchParams);
  }
  if (url.host === 'accounts.google.com') return html('<form><input type="email"><input type="password"></form>');
  if (url.host === 'outlook.live.com' && url.pathname.startsWith('/mail/0/deeplink/compose')) {
    opened.push({ url: request.url, at: Date.now() });
    return outlookCompose(url.searchParams);
  }
  return new Response('not here', { status: 404 });
}

async function main() {
  const partition = session.fromPartition('persist:myharness-third-party');
  partition.protocol.handle('https', answer);
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const send = async (value) => {
    const started = Date.now();
    try {
      return { ...(await browser.command({ action: 'webMailSend', subject: '周报提醒', text: '记得交 DSA 作业\n第二行', to: ['Bob <bob@gmail.com>'], ...value })), took: Date.now() - started };
    } catch (error) {
      return { error: error.message, took: Date.now() - started };
    }
  };
  const windows = () => BrowserWindow.getAllWindows().length;

  // --- a send by the real mouse --------------------------------------------------------------------------------------
  mode = 'ok';
  let result = await send({ provider: 'google', account: 'me@gmail.com', cc: ['amy@x.co'] });
  const address = new URL(opened.at(-1)?.url || 'https://x/');
  check(result.ok === true && result.provider === 'google', 'Gmail sends the message', result);
  check(address.searchParams.get('to') === 'Bob <bob@gmail.com>' && address.searchParams.get('cc') === 'amy@x.co' && address.searchParams.get('su') === '周报提醒' && !address.searchParams.has('body') && address.searchParams.get('authuser') === 'me@gmail.com', 'the compose page opens with the recipients and subject in its address, the text left out', address.search);
  check(sent.length === 1 && sent[0].subject === '周报提醒' && sent[0].to.includes('bob@gmail.com'), 'the website got the message as written', sent);
  const typed = String(sent[0]?.text || '');
  check(typed.includes('记得交 DSA 作业') && typed.includes('第二行') && typed.indexOf('第二行') < typed.indexOf('-- Bob Hu'), 'the text is typed into the message box, above the signature', typed);
  check(result.took < 6000, 'it is sent within seconds', result.took);
  check(windows() === 1, 'the off-screen compose page is closed afterwards', windows());

  // --- a long text, which made the compose address too long when it was put into it ----------------------------------
  const long = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：请在本周五之前提交数据结构作业，并附上实验报告和运行截图。`).join('\n');
  result = await send({ provider: 'google', text: long });
  const longSent = String(sent.at(-1)?.text || '').replace(/\s+/g, '');
  check(result.ok === true && longSent.includes(long.replace(/\s+/g, '')) && opened.at(-1).url.length < 600, 'a long text (several kilobytes encoded) is typed and sent; the address stays short', { result, url: opened.at(-1).url.length, chars: long.length });

  // --- a form that shows up late, and a button only Ctrl+Enter reaches ---------------------------------------------------
  mode = 'late';
  result = await send({ provider: 'google' });
  check(result.ok === true && sent.length === 3, 'a form that takes seconds to appear is waited for', result);
  mode = 'keysOnly';
  result = await send({ provider: 'google' });
  check(result.ok === true && sent.length === 4, 'a Send button that ignores the mouse is pressed with Ctrl+Enter', result);

  // --- what stops a send is said, and nothing is sent twice ----------------------------------------------------------
  mode = 'complaint';
  result = await send({ provider: 'google' });
  check(/拒绝|没有发出/.test(result.error || '') && /not recognized/.test(result.error || ''), "the website's complaint is passed on", result);
  mode = 'signedOut';
  result = await send({ provider: 'google' });
  check(/没有登录/.test(result.error || ''), 'a sign-in page says Gmail is not signed in', result);
  mode = 'noSubject';
  const before = sent.length;
  result = await send({ provider: 'google' });
  check(/没有填好：主题/.test(result.error || '') && sent.length === before, 'a form that lost the subject is not sent', result);
  mode = 'noBody';
  result = await send({ provider: 'google' });
  check(/没有填好：正文（页面上的正文是空的）/.test(result.error || '') && sent.length === before, 'a form that refuses the typed text is not sent and says what it shows', result);

  // --- emoji, which Gmail draws as pictures in the text ----------------------------------------------------------------
  mode = 'emoji';
  result = await send({ provider: 'google', subject: '🙂', text: '🙂' });
  check(result.ok === true && sent.at(-1)?.subject === '🙂', 'a message that is only an emoji is sent', result);
  result = await send({ provider: 'google', text: '记得 ❤️ 交作业\n第二行' });
  check(result.ok === true, 'emoji drawn as pictures inside the text count as the text', result);
  mode = 'silent';
  result = await send({ provider: 'google', timeoutMs: 10000 });
  check(/没有表示已发出/.test(result.error || '') && result.took < 13000, 'a send the website never confirms fails within its time, pointing to Sent', result);
  check(windows() === 1, 'no compose page is left open after failures', windows());

  // --- attachments ---------------------------------------------------------------------------------------------------------
  const files = join(profile, 'attach');
  mkdirSync(files, { recursive: true });
  const notes = join(files, 'notes.txt');
  const report2 = join(files, '实验报告 week 7.pdf');
  writeFileSync(notes, 'hello attachment');
  writeFileSync(report2, Buffer.alloc(300 * 1024, 7));
  mode = 'ok';
  let opensBefore = opened.length;
  result = await send({ provider: 'google', attachments: [notes, report2] });
  const got = sent.at(-1)?.attached || [];
  check(result.ok === true && got.length === 2 && got[0].name === 'notes.txt' && got[0].text === 'hello attachment' && got[1].name === '实验报告 week 7.pdf' && got[1].size === 300 * 1024, "Gmail: the paperclip's file chooser gets both files, and the send waits for their upload", { result, got });
  check(JSON.stringify(result.attached) === JSON.stringify(['notes.txt', '实验报告 week 7.pdf']), 'the result names the attached files', result.attached);
  mode = 'attachNoButton';
  result = await send({ provider: 'google', attachments: [notes] });
  check(result.ok === true && sent.at(-1)?.attached?.[0]?.name === 'notes.txt', "a form without an attach button gets the files through its own file input", { result, last: sent.at(-1) });
  mode = 'attachRefused';
  const beforeRefused = sent.length;
  result = await send({ provider: 'google', attachments: [notes] });
  check(/没有接受附件/.test(result.error || '') && /Attachment failed/.test(result.error || '') && sent.length === beforeRefused, "an attachment the website refuses stops the send, with the website's words", result);
  mode = 'ok';
  opensBefore = opened.length;
  result = await send({ provider: 'google', attachments: [join(files, 'nothing-here.pdf')] });
  check(/附件不存在/.test(result.error || '') && opened.length === opensBefore, 'a missing attachment is reported before any page opens', result);
  result = await send({ provider: 'google', attachments: ['relative/notes.txt'] });
  check(/完整路径/.test(result.error || '') && opened.length === opensBefore, 'an attachment without a full path is refused', result);
  const big = join(files, 'big.bin');
  writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
  result = await send({ provider: 'google', attachments: [big] });
  check(/超过网页邮箱的 25 MB 上限/.test(result.error || '') && opened.length === opensBefore, 'attachments over 25 MB are refused before any page opens', result);

  // --- Outlook ---------------------------------------------------------------------------------------------------------
  result = await send({ provider: 'microsoft', to: ['amy@outlook.com'] });
  check(result.ok === true && sent.at(-1)?.outlook === true && sent.at(-1)?.subject === '周报提醒', 'Outlook sends the message', { result, last: sent.at(-1) });
  check(new URL(opened.at(-1).url).host === 'outlook.live.com', 'a personal Outlook opens outlook.live.com', opened.at(-1));
  check(String(sent.at(-1)?.text || '').startsWith('记得交 DSA 作业') && !String(sent.at(-1)?.recipients || '').includes('DSA'), "Outlook: the text goes into the message body, not into the recipients' box that comes first", sent.at(-1));
  result = await send({ provider: 'microsoft', to: ['amy@outlook.com'], attachments: [notes, report2] });
  check(result.ok === true && (sent.at(-1)?.attached || []).map((item) => item.name).join('|') === 'notes.txt|实验报告 week 7.pdf', 'Outlook: "Attach file" → "Browse this computer" → "Attach as a copy" attaches both files', { result, last: sent.at(-1) });

  // --- no website named: the signed-in Gmail is chosen -------------------------------------------------------------------
  result = await send({});
  check(/没有登录 Gmail 或 Outlook/.test(result.error || ''), 'with no mailbox signed in, it says so', result);
  const future = Math.floor(Date.now() / 1000) + 3600;
  await partition.cookies.set({ url: 'https://mail.google.com/', domain: '.google.com', name: '__Secure-1PSID', value: 'lab', secure: true, expirationDate: future });
  mode = 'ok';
  result = await send({});
  check(result.ok === true && result.provider === 'google' && result.account === 'bob@gmail.com', 'Gmail, signed in by its cookies, is used and its address reported', result);

  // --- two sends due together go one after the other ---------------------------------------------------------------------
  mode = 'late';
  const count = sent.length;
  const pair = await Promise.all([send({ provider: 'google', subject: 'A' }), send({ provider: 'google', subject: 'B' })]);
  const opens = opened.slice(-2).map((item) => item.at);
  check(pair.every((item) => item.ok) && sent.length === count + 2 && sent.at(-2).subject === 'A' && sent.at(-1).subject === 'B', 'two emails due together are both sent, in order', pair);
  check(opens[1] >= sent.at(-2).at, 'the second compose page opens only after the first email went', { opens, sent: sent.slice(-2).map((item) => item.at) });
  check(windows() === 1, 'every compose page is closed in the end', windows());
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    report.failures.push(`crashed: ${error.stack || error.message}`);
  }
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.failures.length ? 1 : 0);
});
