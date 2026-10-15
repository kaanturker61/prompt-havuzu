'use strict';
/* Yol çözümleme: kullanıcıdan gelen göreli yolu marketplace kökü içinde güvenli bir mutlak yola çevirir.
 * Yalnızca sözdizimi değil gerçek yol da denetlenir: sembolik bağlantı/junction kök dışına çıkarıyorsa ya da bağlantı
 * kırıksa reddedilir. Senkron çalışır (birkaç lstat/realpath); hatalar `status` taşıyan Error'dur (server.js httpErr sözleşmesi).
 * Yarış (TOCTOU) için ek koruma yoktur: tehdit modeli yerel ve tek kullanıcılıdır. */

const fs = require('fs');
const path = require('path');
const Rules = require('../public/rules.js');
const paths = require('./paths');

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// NTFS ve macOS büyük-küçük harf duyarsızdır; sondaki nokta/boşluk ve ":akış" eki Windows'ta yok sayılır.
function isDotGit(name) {
  return String(name).split(':')[0].replace(/[. ]+$/, '').toLowerCase() === '.git';
}

/* rel'i rootDir içinde çözer. Dönüş: { abs, rel } (rel: '/' ayraçlı, kökten göreli).
 * 400: boş/geçersiz/kök dışı/bağlantı kök dışına çıkıyor/kırık bağlantı. 403: .git. */
function resolveSafe(rootDir, rel) {
  if (typeof rel !== 'string' || rel === '') throw httpErr(400, 'Yol gerekli');
  if (/[\x00-\x1f\x7f]/.test(rel)) throw httpErr(400, 'Geçersiz yol');
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(norm)) throw httpErr(400, 'Geçersiz yol');
  const abs = path.resolve(rootDir, norm);
  const back = path.relative(rootDir, abs);
  // Yalnızca tam ".." bileşeni kök dışıdır; "..foo.md" gibi adlar geçerlidir.
  if (back === '' || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) throw httpErr(400, 'Geçersiz yol');
  const parts = back.split(path.sep);
  if (parts.some(isDotGit)) throw httpErr(403, '.git klasörüne erişim yok');
  // NTFS alternatif veri akışı (a.md:akis) ve sürücü eki bileşeni.
  if (process.platform === 'win32' && parts.some((p) => p.includes(':'))) throw httpErr(400, 'Geçersiz yol');

  // Gerçek yol: bağlantılar çözülür, hedef yoksa en yakın var olan atası çözülür.
  if (!paths.isInside(abs, rootDir)) throw httpErr(400, 'Geçersiz yol: kök dışına çıkan bağlantı');
  const realRel = path.relative(paths.realish(rootDir), paths.realish(abs));
  if (realRel.split(path.sep).some(isDotGit)) throw httpErr(403, '.git klasörüne erişim yok');

  // Kırık bağlantı: realpath çözülemezse hedef kök dışında olabilir ve yazma onu oluştururdu.
  let cur = rootDir;
  for (const p of parts) {
    cur = path.join(cur, p);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { break; } // buradan sonrası henüz yok
    if (st.isSymbolicLink()) {
      try { fs.realpathSync.native(cur); } catch (e) { throw httpErr(400, 'Geçersiz yol: kırık bağlantı'); }
    }
  }
  return { abs, rel: parts.join('/') };
}

/* Henüz var olmayan yol bileşenlerine Rules.checkEntryName uygular (aygıt adı, 200 bayt, yasak karakter, sonda nokta).
 * rel: resolveSafe'ten dönen '/' ayraçlı yol. Var olan bileşenlere dokunulmaz. Hata 400. */
function checkNewPath(rootDir, rel) {
  let cur = rootDir;
  for (const p of String(rel).split('/').filter(Boolean)) {
    cur = path.join(cur, p);
    let exists = true;
    try { fs.lstatSync(cur); } catch (e) { exists = false; }
    if (exists) continue;
    const err = Rules.checkEntryName(p);
    if (err) throw httpErr(400, err);
  }
}

module.exports = { resolveSafe, checkNewPath, isDotGit };
