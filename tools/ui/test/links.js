'use strict';
/* Test yardımcısı: yalnızca geçici klasörlerde sembolik bağlantı/junction kurar ve kaldırır.
 * Windows'ta dizinler için junction (yönetici gerekmez), dosyalar için sembolik bağlantı kullanılır; kurulamazsa false döner
 * (EPERM gibi), çağıran testi atlar. Kaldırma yalnızca bağlantıyı siler, hedef içeriğine dokunmaz. */

const fs = require('fs');

function makeLink(target, linkPath, kind = 'dir') {
  try {
    fs.symlinkSync(target, linkPath, kind === 'file' ? 'file' : 'junction');
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(e.code)) return false;
    throw e;
  }
}

function removeLink(linkPath) {
  let st = null;
  try { st = fs.lstatSync(linkPath); } catch (e) { return; }
  if (!st.isSymbolicLink() && !st.isDirectory()) return;
  try { fs.rmdirSync(linkPath); } catch (e) { try { fs.unlinkSync(linkPath); } catch (e2) { /* yok sayılır */ } }
}

module.exports = { makeLink, removeLink };
