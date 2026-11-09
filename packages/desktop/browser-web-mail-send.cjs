// One email sent through the Gmail or Outlook website the built-in browser is signed in to, with no person and no model
// working the page: the website's own compose address opens the message with its recipients and subject filled in, in a
// page of the tabs' session that is never shown; the text is typed into the form, the attachments are given to the
// form's own file chooser, and its Send button is pressed. A scheduled email goes out on time this way, and the Agent's
// `mail` tool can send without an API mailbox. The Agent filling the compose form field by field took minutes: the focus
// moved between fields and text landed in the wrong one.
//
// The text is typed, not put into the compose address: a long text (a few hundred Chinese characters are several
// kilobytes once encoded) made the address too long for the website, and the compose page never opened.
//
// The page is the caller's (`contents`, a webContents); this module loads the compose address into it, waits until the
// form shows the recipients and subject, types the text, attaches the files and waits until the website shows them
// uploaded, presses Send (a real mouse click, then Ctrl+Enter, then a scripted click) and waits for the website to
// report the message sent. Each failure names where it stopped: not signed in, a recipient, subject, text or attachment
// the form does not show, a complaint of the website (an address it does not know), no Send button, no answer.
const { statSync } = require('node:fs');
const { basename } = require('node:path');
const { keyEvents } = require(require('node:path').join(__dirname, 'browser-input.cjs'));

const PROVIDERS = ['google', 'microsoft'];
const NAMES = { google: 'Gmail', microsoft: 'Outlook' };
const PERSONAL_OUTLOOK = /@(?:outlook|hotmail|live|msn|passport)\.[a-z.]+$/i;
const ADDRESS = /[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+/;
/** What the two websites take as attachments of one message (Gmail 25 MB; Outlook asks to share a link beyond it). */
const ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
const ATTACHMENTS_MAX = 20;
/** A compose form that has not appeared after this long is loaded once more. */
const REOPEN_AFTER_MS = 20000;

/** The bare address of "Name <address>" or of an address. */
const bareAddress = (value) => (ADDRESS.exec(String(value || '')) || [''])[0].toLowerCase();

/**
 * The website's compose address for a message: Gmail's full-window compose (`view=cm`), or Outlook's compose deep link
 * (outlook.live.com for personal accounts, outlook.office.com for work and school ones), with the recipients and the
 * subject. The text is typed into the form afterwards (see the top of this file). `account` picks the Gmail account
 * when several are signed in; for Outlook it tells personal from work.
 */
function composeAddress(provider, message, { account } = {}) {
  const list = (values) => (Array.isArray(values) ? values.map(String).filter(Boolean).join(',') : '');
  const params = new URLSearchParams();
  const add = (key, value) => { if (value) params.set(key, value); };
  if (provider === 'google') {
    params.set('view', 'cm');
    params.set('fs', '1');
    params.set('tf', '1');
    add('to', list(message.to));
    add('cc', list(message.cc));
    add('bcc', list(message.bcc));
    add('su', String(message.subject || ''));
    if (account && ADDRESS.test(account)) params.set('authuser', bareAddress(account));
    return `https://mail.google.com/mail/?${params}`;
  }
  if (provider === 'microsoft') {
    add('to', list(message.to));
    add('cc', list(message.cc));
    add('bcc', list(message.bcc));
    add('subject', String(message.subject || ''));
    const work = account && ADDRESS.test(account) && !PERSONAL_OUTLOOK.test(bareAddress(account));
    return work ? `https://outlook.office.com/mail/deeplink/compose?${params}` : `https://outlook.live.com/mail/0/deeplink/compose?${params}`;
  }
  throw new Error(`未知的邮箱网站：${provider}`);
}

/**
 * In the page: where the compose form is. `{ state: 'signIn' | 'loading' | 'ready' | 'sent' | 'error', … }`; when ready,
 * what the form shows against what was asked (`missing`: the recipients, subject or text not in it), the Send button's
 * middle (`send`, page CSS pixels, after scrolling it into view) and how much text the message box holds (`written`, its
 * characters other than spaces). Gmail's "View message" link (`#link_vsm`) is its own word that the message went; a form
 * that closed without a complaint counts too once Send was pressed.
 *
 * The message box: Gmail's `g_editable` box; on Outlook the editable box named as the message body, else the largest
 * editable box of the page (Outlook's recipient fields are editable boxes too, and come first).
 */
function composeState(arg) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) => (el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const host = location.hostname;
  if (/^(accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com)$/.test(host) || document.querySelector('input[type="password"]')) return { state: 'signIn', url: location.href };
  const complaint = [...document.querySelectorAll('[role="alertdialog"]')].find(visible);
  if (complaint) return { state: 'error', error: textOf(complaint).slice(0, 300) };
  const google = arg.provider === 'google';
  if (google && document.querySelector('#link_vsm')) return { state: 'sent' };
  const subject = google
    ? document.querySelector('input[name="subjectbox"]')
    : [...document.querySelectorAll('input')].find((el) => visible(el) && /subject|主题|主旨|件名|betreff|objet|asunto|oggetto/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`));
  const messageBox = () => {
    if (google) return document.querySelector('div[g_editable="true"][contenteditable="true"]') || document.querySelector('div[contenteditable="true"][role="textbox"]');
    const boxes = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].filter(visible);
    const named = boxes.find((el) => /message body|邮件正文|郵件正文|正文|本文|nachrichtentext|corps du message|cuerpo del mensaje|corpo del messaggio|corpo da mensagem/i.test(el.getAttribute('aria-label') || ''));
    if (named) return named;
    const area = (el) => { const box = el.getBoundingClientRect(); return box.width * box.height; };
    return boxes.filter((el) => !/^\s*(to|cc|bcc|收件人|抄送|密送|密件抄送|宛先|an|à|para|a)\s*$/i.test(el.getAttribute('aria-label') || '')).sort((a, b) => area(b) - area(a))[0];
  };
  const body = messageBox();
  // Where a page that is not the form stands, for an error that says so (the inbox, an account chooser, an error page).
  const where = { url: location.href, title: document.title.slice(0, 120), hasBody: !!body, hasSubject: !!subject };
  if (!body && !subject) return { state: arg.pressed ? 'closed' : 'loading', ...where };
  if (!body || !visible(body)) return { state: 'loading', ...where };
  // The smallest part of the page that holds the subject and the text: the form, not the mailbox around it. The Send
  // button and the recipients may sit in a row outside that part; a compose page shows one form, so the whole page is
  // looked at for them next.
  let root = body;
  while (subject && root.parentElement && !root.contains(subject)) root = root.parentElement;
  const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.getAttribute('title') || ''}`;
  const findSend = (scope) => {
    const buttons = [...scope.querySelectorAll(google ? '[role="button"]' : 'button, [role="button"]')].filter(visible);
    return buttons.find((el) => /(?:ctrl|⌘|command)\s*[-+]?\s*enter/i.test(labelOf(el)))
      || (google ? scope.querySelector('[role="button"].aoO') : buttons.find((el) => /^\s*(send|发送|傳送|送信|enviar|envoyer|senden|invia)\b/i.test(labelOf(el)) || /^(send|发送|傳送|送信)$/i.test(textOf(el)) || /send/i.test(el.getAttribute('data-testid') || '')));
  };
  const send = findSend(root) || findSend(document);
  // What the form shows: Gmail turns each recipient into a chip carrying its address; Outlook shows names, so there the
  // text that holds the recipients is searched for each address or the name before it.
  const shown = new Set();
  const chips = (scope) => scope.querySelectorAll('[email], [data-hovercard-id]');
  for (const el of chips(root).length ? chips(root) : chips(document)) {
    const value = (el.getAttribute('email') || el.getAttribute('data-hovercard-id') || '').toLowerCase();
    if (value.includes('@')) shown.add(value);
  }
  const rootText = textOf(root).toLowerCase();
  const missing = [];
  for (const address of arg.recipients) {
    if (shown.has(address)) continue;
    if (!google && rootText.includes(address)) continue;
    if (!google && !shown.size) continue;
    missing.push(address);
  }
  if (arg.subject && subject && subject.value.trim() !== arg.subject.trim()) missing.push('subject');
  // The text as written: Gmail draws each emoji as a picture (`<img data-emoji alt>`), which innerText leaves out, so a
  // message of "🙂" looked empty. Spaces, line breaks and emoji variation marks are left out on both sides, since each
  // website lays the text out its own way. Its beginning and its end are looked for, so a text cut short is caught too.
  let written = '';
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) written += node.data;
    else if (node.tagName === 'IMG') written += node.getAttribute('data-emoji') || node.getAttribute('alt') || '';
  }
  const bare = (value) => String(value).replace(/[\s​-‍⁠﻿︎️]+/g, '');
  const wanted = [...bare(arg.text || '')];
  const writtenBare = bare(written);
  if (wanted.length && (!writtenBare.includes(wanted.slice(0, 40).join('')) || !writtenBare.includes(wanted.slice(-20).join('')))) missing.push('text');
  const shownText = written.replace(/\s+/g, ' ').trim();
  let point = null;
  if (send) {
    send.scrollIntoView({ block: 'center', inline: 'center' });
    const box = send.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }
  return { state: 'ready', missing, send: point, written: writtenBare.length, shownText: shownText.length > 60 ? `${shownText.slice(0, 60)}…` : shownText, url: location.href };
}

/**
 * In the page: put the keyboard in the message text, so typing and Ctrl+Enter reach the form. `start`: the caret goes
 * to the beginning of the text, above a signature the website put in.
 */
function focusBody(arg) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  let body;
  if (arg.provider === 'google') {
    body = document.querySelector('div[g_editable="true"][contenteditable="true"]') || document.querySelector('div[contenteditable="true"][role="textbox"]');
  } else {
    const boxes = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].filter(visible);
    const area = (el) => { const box = el.getBoundingClientRect(); return box.width * box.height; };
    body = boxes.find((el) => /message body|邮件正文|郵件正文|正文|本文|nachrichtentext|corps du message|cuerpo del mensaje|corpo del messaggio|corpo da mensagem/i.test(el.getAttribute('aria-label') || ''))
      || boxes.filter((el) => !/^\s*(to|cc|bcc|收件人|抄送|密送|密件抄送|宛先|an|à|para|a)\s*$/i.test(el.getAttribute('aria-label') || '')).sort((a, b) => area(b) - area(a))[0];
  }
  if (!body) return false;
  body.focus();
  if (arg.start) {
    const range = document.createRange();
    range.setStart(body, 0);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return document.activeElement === body || body.contains(document.activeElement);
}

/** In the page: the text typed by the editing command, for a page that missed the typed text (one try, empty box only). */
function typeByCommand(arg) {
  const target = document.activeElement;
  if (!target || !target.isContentEditable) return false;
  return document.execCommand('insertText', false, arg.text);
}

/**
 * In the page: what to press to attach files. `stage: 'button'` — the form's attach button (Gmail's paperclip, Outlook's
 * "Attach file"), not the ones that insert from Drive or OneDrive, pictures or a signature; `stage: 'menu'` — the item
 * of the menu Outlook opens that picks a file of this computer. `stage: 'copy'` — Outlook's "Attach as a copy", asked for
 * a file it would otherwise share as a link. The middle of what was found, or null.
 */
function attachControl(arg) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.getAttribute('title') || ''} ${String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  const pointOf = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), label: labelOf(el).trim().slice(0, 80) } : null;
  };
  const pressable = [...document.querySelectorAll('[command="Files"], button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]')].filter(visible);
  if (arg.stage === 'menu') {
    const item = pressable.find((el) => (/^(menuitem|menuitemradio|option)$/.test(el.getAttribute('role') || '') || el.closest('[role="menu"], [role="listbox"]'))
      && /browse this (computer|pc|device)|this (computer|pc|device)|from (my |this )?computer|upload from computer|浏览此计算机|浏览这台电脑|浏览此电脑|此计算机|此电脑|这台电脑|瀏覽此電腦|此電腦|本机|本機|コンピューターを参照|このコンピューター|diesen computer|cet ordinateur|este equipo|questo computer|este computador/i.test(labelOf(el)));
    return item ? pointOf(item) : null;
  }
  if (arg.stage === 'copy') {
    const button = pressable.find((el) => /attach as (a )?copy|作为副本附加|以副本形式附加|附加副本|作為複本附加|附加複本|コピーとして添付|als kopie anfügen|als kopie anhängen|joindre (en tant que |une )copie|adjuntar como copia|allega come copia|anexar como cópia/i.test(labelOf(el)));
    return button ? pointOf(button) : null;
  }
  const other = /signature|签名|簽名|署名|signatur|drive|云端|雲端|onedrive|cloud|photo|照片|相片|picture|图片|圖片|写真|画像|emoji|表情|link|链接|連結|リンク|inline|内嵌|insert/i;
  let button = arg.provider === 'google' ? [...document.querySelectorAll('[command="Files"]')].find(visible) : null;
  button ||= pressable.find((el) => /attach|附件|附加|添付|anhängen|anhang|joindre|pièce jointe|adjuntar|allega|anexar/i.test(labelOf(el)) && !other.test(labelOf(el)));
  return button ? pointOf(button) : null;
}

/**
 * In the page: how the attachments look. `shown`: the file names the page shows outside the message text (a name the
 * text itself mentions does not count); `uploading`: a progress bar or "uploading" is still on the page; `complaint`: an
 * alert the website put up.
 */
function attachmentState(arg) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const google = arg.provider === 'google';
  const boxes = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].filter(visible);
  const area = (el) => { const box = el.getBoundingClientRect(); return box.width * box.height; };
  const body = google
    ? document.querySelector('div[g_editable="true"][contenteditable="true"]') || document.querySelector('div[contenteditable="true"][role="textbox"]')
    : boxes.find((el) => /message body|邮件正文|郵件正文|正文|本文|nachrichtentext|corps du message|cuerpo del mensaje|corpo del messaggio|corpo da mensagem/i.test(el.getAttribute('aria-label') || '')) || boxes.sort((a, b) => area(b) - area(a))[0];
  const parts = [];
  if (document.body) {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node === body || node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.data);
      else for (const name of ['aria-label', 'title', 'data-tooltip']) { const value = node.getAttribute(name); if (value) parts.push(value); }
    }
  }
  const hay = parts.join('\n').toLowerCase();
  const shown = arg.names.filter((name) => {
    const lower = String(name).toLowerCase();
    const stem = lower.replace(/\.[^.]+$/, '').slice(0, 24);
    return hay.includes(lower) || (stem.length >= 4 && hay.includes(stem));
  });
  const uploading = [...document.querySelectorAll('[role="progressbar"]')].some(visible)
    || /uploading|正在上传|上传中|上傳中|アップロード中|wird hochgeladen|téléversement|subiendo|caricamento in corso/i.test(hay);
  const complaint = [...document.querySelectorAll('[role="alertdialog"]')].find(visible);
  return { shown, uploading, complaint: complaint ? String(complaint.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '' };
}

/** In the page: the Send button pressed by script (mouse down, up, click), for a form that missed the real click. */
function scriptedSend(arg) {
  const at = document.elementFromPoint(arg.x, arg.y);
  const button = at && (at.closest('[role="button"], button') || at);
  if (!button) return false;
  for (const type of ['mousedown', 'mouseup', 'click']) button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: arg.x, clientY: arg.y, button: 0 }));
  return true;
}

/** In the page: a file input of the form that takes any file, for a page whose attach button was not found or opened nothing. */
function anyFileInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')].filter((el) => !el.disabled && !/^\s*image\/\*\s*$/i.test(el.getAttribute('accept') || ''));
  return inputs.find((el) => el.multiple) || inputs[0] || null;
}

const pageCall = (fn, arg) => `(${fn})(${JSON.stringify(arg ?? null)})`;

/**
 * The files of a message, checked: existing ordinary files, at most ATTACHMENTS_MAX, together at most
 * ATTACHMENT_LIMIT_BYTES. `[{ path, name, size }]`; throws with the file that does not fit.
 */
function attachmentFiles(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  if (list.length > ATTACHMENTS_MAX) throw new Error(`一封邮件最多带 ${ATTACHMENTS_MAX} 个附件`);
  let total = 0;
  const files = list.map((path) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      throw new Error(`附件不存在：${path}`);
    }
    if (!info.isFile()) throw new Error(`附件只能是普通文件，不能是目录：${path}`);
    total += info.size;
    return { path, name: basename(path), size: info.size };
  });
  if (total > ATTACHMENT_LIMIT_BYTES) throw new Error(`附件一共 ${(total / 1048576).toFixed(1)} MB，超过网页邮箱的 ${ATTACHMENT_LIMIT_BYTES / 1048576} MB 上限；请改为发送网盘链接`);
  return files;
}

/**
 * Send `message` ({ to, cc?, bcc?, subject, text, attachments? }) through `provider`'s website in `contents`.
 * `attachments`: absolute paths of files. Resolves with `{ ok: true, provider, ms, attached }`; rejects with what stopped
 * it. `timeoutMs` covers the whole send.
 */
async function sendThroughPage(contents, { provider, message, account, timeoutMs = 60000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = () => undefined } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`未知的邮箱网站：${provider}`);
  const name = NAMES[provider];
  const recipients = [...(message.to || []), ...(message.cc || []), ...(message.bcc || [])].map(bareAddress).filter(Boolean);
  if (!(message.to || []).map(bareAddress).filter(Boolean).length) throw new Error('邮件没有收件人');
  if (!String(message.subject || '').trim()) throw new Error(`用 ${name} 网页发信需要主题`);
  const files = attachmentFiles(message.attachments);
  const text = String(message.text || '').replace(/\r\n?/g, '\n');
  const started = now();
  const deadline = started + Math.max(5000, Number(timeoutMs) || 60000);
  const form = { provider, recipients, subject: String(message.subject || ''), text: '' };
  const expect = { ...form, text };
  let gone = false;
  contents.once?.('destroyed', () => { gone = true; });
  const run = async (fn, arg) => {
    if (gone || contents.isDestroyed?.()) return { state: 'closed' };
    try {
      return await contents.executeJavaScript(pageCall(fn, arg), true);
    } catch (error) {
      // A page that is replacing itself (Gmail's redirects) answers nothing for a moment; one that closed is gone.
      if (gone || contents.isDestroyed?.()) return { state: 'closed' };
      log(`写信页暂时没有回应：${error.message}`);
      return { state: 'loading' };
    }
  };
  const debuggerApi = contents.debugger;
  let attached = false;
  const cdp = async (method, params) => {
    if (!attached && !debuggerApi.isAttached()) { debuggerApi.attach('1.3'); attached = true; }
    return debuggerApi.sendCommand(method, params);
  };
  const click = async (point) => {
    const mouse = (params) => cdp('Input.dispatchMouseEvent', { pointerType: 'mouse', modifiers: 0, ...params });
    await mouse({ type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
    await mouse({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await mouse({ type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const notFilled = (state) => {
    const what = state.missing.map((item) => (item === 'subject' ? '主题' : item === 'text' ? '正文' : item));
    const shown = state.missing.includes('text') ? `（页面上的正文${state.shownText ? `是“${state.shownText}”` : '是空的'}）` : '';
    return new Error(`${name} 写信页没有填好：${what.join('、')}${shown}；没发出的信可能留在草稿箱`);
  };
  /**
   * The form as `want` asks, waited for; it gets `graceMs` after it is up to show everything asked. `reopen`: a form
   * that has not appeared after REOPEN_AFTER_MS is loaded once more (the website sometimes lands on its inbox or an
   * empty page instead). Running out of time says where the page stood, so a failure can be told apart afterwards.
   */
  const formReady = async (want, graceMs, { reopen } = {}) => {
    let readyAt = 0;
    let reopened = false;
    let last = null;
    const since = now();
    for (;;) {
      const state = await run(composeState, want);
      last = state;
      if (state.state === 'signIn') throw new Error(`内置浏览器里的 ${name} 没有登录，请先在内置浏览器登录 ${name}`);
      if (state.state === 'error') throw new Error(`${name} 拒绝了这封邮件：${state.error}`);
      if (state.state === 'closed') throw new Error(`${name} 写信页关掉了`);
      if (state.state === 'ready') {
        readyAt ||= now();
        if (!state.missing.length && state.send) return state;
        if (now() - readyAt > graceMs) {
          if (!state.send) throw new Error(`${name} 写信页上找不到“发送”按钮`);
          throw notFilled(state);
        }
      }
      if (now() > deadline) {
        const seconds = Math.round((now() - started) / 1000);
        if (last?.state === 'ready') {
          log(`${name} 写信页到时间还没填好：${JSON.stringify({ missing: last.missing, send: !!last.send, url: last.url })}`);
          if (!last.send) throw new Error(`${name} 写信页 ${seconds} 秒内没有出现“发送”按钮`);
          throw notFilled(last);
        }
        const stood = last?.title || last?.url ? `；页面停在“${last.title || ''}”${last.url ? ` ${String(last.url).slice(0, 160)}` : ''}${last.hasBody === false ? '，没有正文框' : ''}${last.hasSubject === false ? '，没有主题框' : ''}` : '';
        log(`${name} 写信页 ${seconds} 秒内没有出现${stood}`);
        throw new Error(`${name} 写信页 ${seconds} 秒内没有出现${stood}`);
      }
      if (reopen && !reopened && !readyAt && state.state === 'loading' && now() - since > REOPEN_AFTER_MS) {
        reopened = true;
        log(`${name} 写信页 ${Math.round((now() - since) / 1000)} 秒还没出现（${String(state.url || '').slice(0, 120)}），重新打开一次`);
        await contents.loadURL(reopen).catch(() => undefined);
      }
      await sleep(250);
    }
  };
  try {
    const address = composeAddress(provider, message, { account });
    await contents.loadURL(address).catch((error) => {
      // The website sending itself to its own address aborts the first load; the page it went to is the one used.
      if (!/ERR_ABORTED|\(-3\)/.test(String(error?.message))) throw new Error(`打不开 ${name} 写信页：${error.message}`);
    });
    // 1. The form, with the recipients and the subject. A form that is up but still lacks them gets a few seconds.
    let state = await formReady(form, 5000, { reopen: address });
    // Gmail draws the form before its fields and buttons listen; a moment later typing and a click are taken.
    await sleep(400);
    // 2. The text, typed where the caret is put: at the beginning of the message box, above a signature.
    if (text.trim()) {
      await run(focusBody, { provider, start: true });
      await cdp('Input.insertText', { text });
      try {
        state = await formReady(expect, 3000);
      } catch (error) {
        // A page that took nothing typed gets the text once more through its editing command; a page that took part of
        // it is not typed into twice.
        const typed = await run(composeState, expect);
        if (typed.state !== 'ready' || typed.written > 0) throw error;
        await run(focusBody, { provider, start: true });
        await run(typeByCommand, { text });
        state = await formReady(expect, 3000);
      }
    }
    // 3. The attachments, given to the file chooser the form's own attach button opens.
    if (files.length) await attachThrough({ provider, name, files, run, cdp, click, debuggerApi, sleep, now, deadline, log });
    // Everything once more before the button is pressed: an attachment step must not have lost the text.
    state = await formReady(expect, 3000);
    const point = state.send;
    // 4. Send: a real click on the button, then Ctrl+Enter in the text, then a scripted click, each given a few seconds.
    const tries = [
      async () => { await click(point); },
      async () => {
        await run(focusBody, { provider });
        for (const event of keyEvents('Control+Enter')) await cdp('Input.dispatchKeyEvent', event);
      },
      async () => { await run(scriptedSend, point); },
    ];
    for (const [index, press] of tries.entries()) {
      if (gone) break;
      try {
        await press();
      } catch (error) {
        log(`按“发送”的第 ${index + 1} 种方式没有成功：${error.message}`);
      }
      // 5. The website's answer: sent, a complaint, or the form still waiting (then the next way of pressing Send).
      const waitUntil = Math.min(deadline, now() + (index < tries.length - 1 ? 3000 : 15000));
      for (;;) {
        const after = gone ? { state: 'closed' } : await run(composeState, { ...expect, pressed: true });
        if (after.state === 'error') throw new Error(`${name} 没有发出这封邮件：${after.error}`);
        if (after.state === 'signIn') throw new Error(`${name} 要求重新登录，邮件没有发出`);
        if (after.state === 'sent' || after.state === 'closed') {
          // A complaint can come a moment after the form closes (an address it checked on the server).
          await sleep(gone ? 0 : 600);
          const settled = gone ? { state: 'closed' } : await run(composeState, { ...expect, pressed: true });
          if (settled.state === 'error') throw new Error(`${name} 没有发出这封邮件：${settled.error}`);
          return { ok: true, provider, ms: now() - started, ...(files.length ? { attached: files.map((file) => file.name) } : {}) };
        }
        if (now() > waitUntil) break;
        await sleep(250);
      }
      if (now() > deadline) break;
    }
  } finally {
    if (attached) { try { debuggerApi.detach(); } catch { /* already gone */ } }
  }
  throw new Error(`按了“发送”，但 ${name} 在 ${Math.round((now() - started) / 1000)} 秒内没有表示已发出；请到“已发送”里确认，草稿可能还在草稿箱`);
}

/**
 * The files attached through the form: its attach button is pressed with the file chooser taken over (DevTools
 * `Page.setInterceptFileChooserDialog`, so no window opens), the chooser the website opens gets the files, and the page
 * is waited for until it shows every file name with no upload still running. Outlook's menu ("Browse this computer") and
 * its "Attach as a copy" question are answered on the way. A page whose button opens no chooser has the files put into
 * its own file input.
 */
async function attachThrough({ provider, name, files, run, cdp, click, debuggerApi, sleep, now, deadline, log }) {
  const choosers = [];
  const onMessage = (_event, method, params) => { if (method === 'Page.fileChooserOpened') choosers.push(params); };
  debuggerApi.on('message', onMessage);
  const chooser = async (ms) => {
    const until = now() + ms;
    while (!choosers.length && now() < until) await sleep(100);
    return choosers.shift();
  };
  const totalMb = files.reduce((sum, file) => sum + file.size, 0) / 1048576;
  let remaining = files.map((file) => file.path);
  try {
    await cdp('Page.enable');
    await cdp('DOM.enable');
    await cdp('Page.setInterceptFileChooserDialog', { enabled: true });
    for (let attempt = 0; remaining.length && attempt < files.length + 2 && now() < deadline; attempt++) {
      const button = await run(attachControl, { provider, stage: 'button' });
      if (!button?.x) break;
      await click(button);
      let opened = await chooser(2500);
      if (!opened) {
        const item = await run(attachControl, { provider, stage: 'menu' });
        if (item?.x) {
          await click(item);
          opened = await chooser(2500);
        }
      }
      if (!opened) break;
      const batch = opened.mode === 'selectMultiple' ? remaining : remaining.slice(0, 1);
      if (opened.backendNodeId) {
        await cdp('DOM.setFileInputFiles', { files: batch, backendNodeId: opened.backendNodeId });
        remaining = remaining.slice(batch.length);
      } else {
        break;
      }
      await sleep(300);
    }
    if (remaining.length) {
      // No button found, or it opened no chooser: the form's own file input, if it has one.
      const found = await cdp('Runtime.evaluate', { expression: `(${anyFileInput})()` });
      const objectId = found?.result?.objectId;
      if (!objectId) throw new Error(`${name} 写信页上找不到“添加附件”按钮，附件没有加上；信没有发出`);
      const multiple = (await cdp('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return this.multiple; }', returnByValue: true }))?.result?.value === true;
      for (const batch of multiple ? [remaining] : remaining.map((path) => [path])) {
        await cdp('DOM.setFileInputFiles', { files: batch, objectId });
        await sleep(300);
      }
      remaining = [];
    }
  } finally {
    try { await cdp('Page.setInterceptFileChooserDialog', { enabled: false }); } catch { /* page gone */ }
    debuggerApi.removeListener('message', onMessage);
  }
  // The page shows each file, uploaded: a little time per megabyte, within the whole send's time.
  const names = files.map((file) => file.name);
  const uploadStarted = now();
  const until = Math.min(deadline - 3000, uploadStarted + 20000 + Math.ceil(totalMb) * 3000);
  let settled = 0;
  for (;;) {
    const copy = provider === 'microsoft' ? await run(attachControl, { provider, stage: 'copy' }) : null;
    if (copy?.x) {
      log(`Outlook 问附件怎样附上，选“作为副本附加”：${copy.label}`);
      await click(copy);
      await sleep(400);
      continue;
    }
    const state = await run(attachmentState, { provider, names });
    if (state.complaint) throw new Error(`${name} 没有接受附件：${state.complaint}`);
    const done = Array.isArray(state.shown) && state.shown.length === names.length && !state.uploading;
    settled = done ? settled + 1 : 0;
    if (settled >= 2) return;
    if (now() > until) {
      const missing = names.filter((item) => !(state.shown || []).includes(item));
      if (missing.length) throw new Error(`${name} 写信页上没有出现附件：${missing.join('、')}；信没有发出，草稿可能在草稿箱`);
      throw new Error(`${name} 的附件 ${Math.round((now() - uploadStarted) / 1000)} 秒内没有上传完；信没有发出，草稿可能在草稿箱`);
    }
    await sleep(400);
  }
}

module.exports = { composeAddress, composeState, sendThroughPage, bareAddress, attachmentFiles, PROVIDERS, ATTACHMENT_LIMIT_BYTES, ATTACHMENTS_MAX };
