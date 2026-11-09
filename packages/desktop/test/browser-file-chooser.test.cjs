const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { uploadFiles, MAX_FILES } = require('../browser-file-chooser.cjs');

/** A fake user folder with a chat folder, ordinary files and the places that hold sign-ins. */
function fakeHome() {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'mh-upload-home-')));
  const put = (relative, text = 'x') => {
    const file = join(home, relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  return { home, put, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('files come from the chat folders by relative path, and from anywhere ordinary in the user folder', () => {
  const { home, put, done } = fakeHome();
  try {
    const chat = join(home, 'Study', 'OS');
    put('Study/OS/answer.pdf', 'pdf');
    const drive = put('My Drive/Study/Subject/OS/作业/report.pdf', 'report');
    const temp = put('AppData/Local/Temp/mock_pdf_build/v2.pdf', 'built');
    const [relative] = uploadFiles('answer.pdf', { roots: [chat], home });
    assert.equal(relative.name, 'answer.pdf');
    assert.equal(relative.shown, 'answer.pdf');
    const both = uploadFiles([drive, temp], { roots: [chat], home });
    assert.deepEqual(both.map((file) => file.shown), ['~/My Drive/Study/Subject/OS/作业/report.pdf', '~/AppData/Local/Temp/mock_pdf_build/v2.pdf']);
    assert.equal(both[0].size, 6);
  } finally {
    done();
  }
});

test('sign-ins, keys and app data in the user folder are refused, and so is anything outside it', () => {
  const { home, put, done } = fakeHome();
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'mh-upload-elsewhere-')));
  try {
    const chat = join(home, 'chat');
    mkdirSync(chat);
    for (const blocked of ['.ssh/id_ed25519', '.myharness/agent/auth.json', '.aws/credentials', 'AppData/Roaming/Code/state.txt', 'appdata/local/Google/Chrome/Cookies']) {
      assert.throws(() => uploadFiles(put(blocked), { roots: [chat], home }), /登录信息、密钥或程序数据/, blocked);
    }
    for (const secret of ['Documents/server.pem', 'project/.env', 'project/.env.local', 'keys/id_rsa']) {
      assert.throws(() => uploadFiles(put(secret), { roots: [chat], home }), /登录信息、密钥或程序数据/, secret);
    }
    // The chat's own folder may hold such names (the user's project), and a file there is the chat's.
    writeFileSync(join(chat, '.env'), 'A=1');
    assert.equal(uploadFiles('.env', { roots: [chat], home })[0].name, '.env');
    writeFileSync(join(elsewhere, 'other.txt'), 'x');
    assert.throws(() => uploadFiles(join(elsewhere, 'other.txt'), { roots: [chat], home }), /只能上传你用户文件夹/);
  } finally {
    done();
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a link inside the user folder that points at a blocked place is followed and refused', () => {
  const { home, put, done } = fakeHome();
  try {
    put('.ssh/id_ed25519', 'secret');
    symlinkSync(join(home, '.ssh'), join(home, 'innocent'), 'junction');
    assert.throws(() => uploadFiles(join(home, 'innocent', 'id_ed25519'), { roots: [], home }), /登录信息、密钥或程序数据/);
  } finally {
    done();
  }
});

test('folders, missing files, too many files and relative paths without a folder are refused', () => {
  const { home, put, done } = fakeHome();
  try {
    const chat = join(home, 'chat');
    mkdirSync(join(chat, 'sub'), { recursive: true });
    assert.throws(() => uploadFiles('sub', { roots: [chat], home }), /普通文件/);
    assert.throws(() => uploadFiles('nope.txt', { roots: [chat], home }), /不存在/);
    assert.throws(() => uploadFiles('a.txt', { roots: [], home }), /绝对路径/);
    assert.throws(() => uploadFiles([], { roots: [chat], home }), /需要文件路径/);
    const file = put('chat/a.txt');
    assert.throws(() => uploadFiles(Array.from({ length: MAX_FILES + 1 }, () => file), { roots: [chat], home }), /最多上传/);
  } finally {
    done();
  }
});
