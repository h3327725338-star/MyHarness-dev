const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolve } = require('node:path');
const { windowsToastOptions } = require('../notification-toast.cjs');

test('Windows owns banner and audio in one toast, including explicit silence', () => {
  for (const [sound, event] of [
    ['soft', 'Notification.Default'], ['chime', 'Notification.Mail'], ['glow', 'Notification.Reminder'],
    ['off', null], [undefined, null], ['constructor', null],
  ]) {
    const { toastXml } = windowsToastOptions({ title: '任务完成', body: '已处理', sound });
    const audio = event ? `<audio src="ms-winsoundevent:${event}"/>` : '<audio silent="true"/>';
    assert.equal(toastXml, `<toast><visual><binding template="ToastGeneric"><text>任务完成</text><text>已处理</text></binding></visual>${audio}</toast>`);
  }
});

test('chat text cannot inject toast options or break XML at the truncation boundary', () => {
  const { toastXml } = windowsToastOptions({ title: `${'x'.repeat(119)}🙂`, body: '中文🙂 <audio/> & "\'\u0000\n' }, resolve('some icon.ico'));
  assert.ok(toastXml.includes(`<text>${'x'.repeat(119)}</text>`));
  assert.ok(toastXml.includes('<text>中文🙂 &lt;audio/&gt; &amp; &quot;&apos;\n</text>'));
  assert.match(toastXml, /<image placement="appLogoOverride" hint-crop="none" src="file:\/\/\/[^"]*some%20icon\.ico"\/>/u);
});
