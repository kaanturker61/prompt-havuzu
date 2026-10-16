'use strict';
/* Ağ hatası kodlarının Türkçe iletileri (push, fetch, clone ortak kullanır). */

const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

function isSshUrl(url) {
  const s = String(url || '');
  return /^ssh:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
}

// code: GitService.classifyGitNetError çıktısı. opts: { url, dir }
function describeNetError(code, opts = {}) {
  const dir = opts.dir || tx('net.dirPlaceholder');
  switch (code) {
    case 'kimlik':
      return isSshUrl(opts.url) ? tx('net.kimlikSsh') : tx('net.kimlik', { dir });
    case 'ag': return tx('net.ag');
    case 'bulunamadi': return tx('net.bulunamadi');
    case 'reddedildi': return tx('net.reddedildi', { dir });
    case 'zamanAsimi': return tx('net.zamanAsimi');
    case 'mesgul': return tx('net.mesgul');
    case 'atomikYok': return tx('net.atomikYok');
    default: return tx('net.bilinmiyor');
  }
}

module.exports = { describeNetError, isSshUrl };
