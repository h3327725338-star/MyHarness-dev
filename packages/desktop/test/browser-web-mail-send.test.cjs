const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { composeAddress, bareAddress, sendThroughPage, attachmentFiles } = require('../browser-web-mail-send.cjs');

test('the compose address carries the recipients and subject (the text is typed), and the account picks the mailbox', () => {
  const message = { to: ['Bob <bob@gmail.com>', 'amy@x.co'], cc: ['c@x.co'], bcc: [], subject: '提醒 & 计划', text: '第一行\n第二行 ?=&' };
  const gmail = new URL(composeAddress('google', message, { account: 'Me <Me@Gmail.com>' }));
  assert.equal(gmail.origin + gmail.pathname, 'https://mail.google.com/mail/');
  assert.equal(gmail.searchParams.get('view'), 'cm');
  assert.equal(gmail.searchParams.get('to'), 'Bob <bob@gmail.com>,amy@x.co');
  assert.equal(gmail.searchParams.get('cc'), 'c@x.co');
  assert.equal(gmail.searchParams.has('bcc'), false);
  assert.equal(gmail.searchParams.get('su'), '提醒 & 计划');
  // The text is typed into the form: put into the address, a long one made it too long for the website.
  assert.equal(gmail.searchParams.has('body'), false);
  assert.equal(gmail.searchParams.get('authuser'), 'me@gmail.com');
  // No account: whichever Gmail account the browser opens first.
  assert.equal(new URL(composeAddress('google', message)).searchParams.has('authuser'), false);

  const personal = new URL(composeAddress('microsoft', message, { account: 'me@hotmail.com' }));
  assert.equal(personal.origin + personal.pathname, 'https://outlook.live.com/mail/0/deeplink/compose');
  assert.equal(personal.searchParams.get('subject'), '提醒 & 计划');
  assert.equal(personal.searchParams.has('body'), false);
  // A work or school address goes to Microsoft 365's Outlook; a name only (what Outlook's title shows) to the personal one.
  assert.equal(new URL(composeAddress('microsoft', message, { account: 'bob@school.edu.my' })).host, 'outlook.office.com');
  assert.equal(new URL(composeAddress('microsoft', message, { account: 'Bob Hu' })).host, 'outlook.live.com');
  assert.throws(() => composeAddress('yahoo', message), /未知的邮箱网站/);
  assert.equal(bareAddress('Bob <Bob@Gmail.com>'), 'bob@gmail.com');
  assert.equal(bareAddress('nobody'), '');
});

test('a message without a recipient or a subject is refused before any page opens', async () => {
  const contents = { loadURL: () => assert.fail('no page should open') };
  await assert.rejects(sendThroughPage(contents, { provider: 'google', message: { cc: ['a@b.co'], subject: 's' } }), /没有收件人/);
  await assert.rejects(sendThroughPage(contents, { provider: 'google', message: { to: ['a@b.co'], subject: ' ' } }), /需要主题/);
  await assert.rejects(sendThroughPage(contents, { provider: 'yahoo', message: { to: ['a@b.co'], subject: 's' } }), /未知的邮箱网站/);
});

test('attachments are checked before any page opens: existing files, not folders, within the size and count limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-mail-'));
  try {
    const small = join(dir, 'a.txt');
    writeFileSync(small, 'hello');
    mkdirSync(join(dir, 'folder'));
    assert.deepEqual(attachmentFiles([small]), [{ path: small, name: 'a.txt', size: 5 }]);
    assert.throws(() => attachmentFiles([join(dir, 'missing.pdf')]), /附件不存在/);
    assert.throws(() => attachmentFiles([join(dir, 'folder')]), /不能是目录/);
    assert.throws(() => attachmentFiles(Array.from({ length: 21 }, () => small)), /最多带 20 个附件/);
    const contents = { loadURL: () => assert.fail('no page should open') };
    await assert.rejects(sendThroughPage(contents, { provider: 'google', message: { to: ['a@b.co'], subject: 's', attachments: [join(dir, 'missing.pdf')] } }), /附件不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a compose form that never appears is loaded once more, and the error says where the page stood', async () => {
  let clock = 0;
  const loads = [];
  const logs = [];
  const contents = {
    loadURL: async (url) => { loads.push(url); },
    // The website keeps showing its inbox: no message box, no subject.
    executeJavaScript: async () => ({ state: 'loading', url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox - me@gmail.com - Gmail', hasBody: false, hasSubject: false }),
    debugger: { isAttached: () => false, attach: () => undefined, detach: () => undefined, sendCommand: async () => ({}) },
  };
  await assert.rejects(
    sendThroughPage(contents, { provider: 'google', message: { to: ['a@b.co'], subject: 's', text: 'hi' }, timeoutMs: 60000, sleep: async (ms) => { clock += ms; }, now: () => clock, log: (line) => logs.push(line) }),
    (error) => /写信页 60 秒内没有出现；页面停在“Inbox - me@gmail.com - Gmail” https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox，没有正文框，没有主题框/.test(error.message),
  );
  assert.equal(loads.length, 2, 'the compose address is loaded a second time');
  assert.equal(loads[0], loads[1]);
  assert.ok(logs.some((line) => /重新打开一次/.test(line)) && logs.some((line) => /没有出现/.test(line)), logs.join('\n'));
});
