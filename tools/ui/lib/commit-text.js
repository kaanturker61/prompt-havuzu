'use strict';
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

/** Summary: Paket yayını commit konusu; işlem anındaki dilde üretilir. */
function publishSubject(name, version) {
  return tx('gitmsg.publishSubject', { name, version });
}

/** Summary: Marketplace güncelleme commit konusu; işlem anındaki dilde üretilir. */
function updateSubject() {
  return tx('gitmsg.updateSubject');
}

/** Summary: Paket etiketinin notu: dilden bağımsız "ad sürüm" başlığı, ardından değişen çıktı satırları ya da değişiklik yok cümlesi. */
function tagNote(name, version, prompts, removed) {
  const lines = [];
  for (const p of prompts) {
    if (p.change === 'yeni') lines.push(tx('gitmsg.changeNew', { target: p.target }));
    else if (p.change === 'degisti') lines.push(tx('gitmsg.changeModified', { target: p.target }));
  }
  for (const r of removed) lines.push(tx('gitmsg.changeRemoved', { target: r.target }));
  return `${name} ${version}\n\n` + (lines.join('\n') || tx('gitmsg.noChange'));
}

module.exports = { publishSubject, updateSubject, tagNote };
