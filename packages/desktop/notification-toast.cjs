const { pathToFileURL } = require('node:url');

// The portable app has no package identity for ms-appx audio. Use Windows' built-in
// events so the notification platform, not the renderer, schedules the audio.
const sounds = new Map([
  ['soft', 'Notification.Default'],
  ['chime', 'Notification.Mail'],
  ['glow', 'Notification.Reminder'],
]);

function escapeXml(value) {
  // Strip characters that cannot appear in XML 1.0 (including a lone surrogate after truncation).
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function windowsToastOptions({ title, body, sound }, icon) {
  const clean = (value, max) => escapeXml(String(value ?? '').slice(0, max));
  const text = [clean(title, 120), clean(body, 300)].filter(Boolean).map((line) => `<text>${line}</text>`).join('');
  const logo = icon ? `<image placement="appLogoOverride" hint-crop="none" src="${escapeXml(pathToFileURL(icon).href)}"/>` : '';
  const event = sounds.get(sound);
  const audio = event ? `<audio src="ms-winsoundevent:${event}"/>` : '<audio silent="true"/>';
  return { toastXml: `<toast><visual><binding template="ToastGeneric">${text || '<text>[no message]</text>'}${logo}</binding></visual>${audio}</toast>` };
}

module.exports = { windowsToastOptions };
