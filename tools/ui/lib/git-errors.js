'use strict';
/* Yerel git hatalarının (commit, add, sürüm, yayın) Türkçe iletileri ve ayrıntı arındırması.
 * net-errors.js kalıbı: git çalıştırmaz, yalnızca metin üretir. Sınıflandırma git-service.js'teki classifyGitError'dadır. */

const { GitError, GitNotFoundError, classifyGitError } = require('./git-service');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

const MAX_DETAIL = 600;
const MAX_INPUT = 20000; // dev çıktılarda düzenli ifadeler gereksiz çalışmasın; arındırma sonrası zaten 600'e inecek
const PATH_MARK = '<yol>';

// code: classifyGitError çıktısı (kilit | commitReddedildi | eklenemedi | bilinmiyor). Her ileti noktayla biter.
function describeGitError(code) {
  switch (code) {
    case 'kilit':
      return tx('git.error.kilit');
    case 'commitReddedildi':
      return tx('git.error.commitReddedildi');
    case 'eklenemedi':
      return tx('git.error.eklenemedi');
    default:
      return tx('git.error.bilinmiyor');
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Kökü iki ayraç biçimiyle (\ ve /), büyük-küçük harf duyarsız eşleyen düzenli ifade. Çok kısa kökler (örn. "/" ya da "C:") atlanır.
function rootRegex(root) {
  const s = String(root == null ? '' : root);
  const parts = s.split(/[\\/]+/).filter((x) => x !== '');
  if (!parts.length || s.replace(/[\\/]+$/, '').length < 3) return null;
  const lead = /^[\\/]/.test(s) ? '[\\\\/]+' : '';
  // Önünde ve arkasında yol/sözcük karakteri olmamalı (/var/tmp/x içindeki /tmp/x ya da mk2 içindeki mk eşleşmesin).
  return new RegExp('(?<![\\p{L}\\p{N}_./\\\\-])' + lead + parts.map(escapeRe).join('[\\\\/]+') + '(?![\\p{L}\\p{N}_-])', 'giu');
}

/* Git çıktısındaki mutlak yolları <yol> yapar ve en çok 600 karaktere kısaltır. Hook çıktısı gibi geri kalan metne dokunmaz.
 * roots: önce bunlar (marketplace kökü) değiştirilir, kökün altındaki göreli kısım kalır (<yol>/.git/index.lock). */
function sanitizeDetail(text, roots = []) {
  let s = String(text == null ? '' : text).slice(0, MAX_INPUT).replace(/\r\n?/g, '\n');
  for (const r of roots || []) {
    const re = rootRegex(r);
    if (re) s = s.replace(re, PATH_MARK);
  }
  s = s
    // tırnaklı mutlak yollar (boşluk içerebilir): 'C:/x y/z', "/home/x", '\\sunucu\paylasim'
    .replace(/(['"])(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)[^'"\n]*\1/g, '$1' + PATH_MARK + '$1')
    // tırnaksız: sürücü harfli, UNC ve POSIX (yalnızca sözcük başında; refs/heads/main gibi göreli yollar korunur)
    .replace(/(?<![\w])[A-Za-z]:[\\/][^\s'"<>|*?]*/g, PATH_MARK)
    .replace(/(?<![\w\\])\\\\[^\s'"<>|*?]+/g, PATH_MARK)
    .replace(/(?<=^|[\s'"(=,])\/[^\s'"()<>,;]+/g, PATH_MARK)
    .trim();
  if (s.length > MAX_DETAIL) {
    let cut = s.slice(0, MAX_DETAIL - 1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // ikiye bölünmüş vekil çift kalmasın
    s = cut + '…';
  }
  return s;
}

// Git sürecinin gerçekten başarısız olması (çıkış kodu ya da stderr var). Servisin kendi Türkçe hataları
// ("Geçersiz commit", "Araç reposunda git işlemi yapılamaz", "git bulunamadı") ve git dışı hatalar buna girmez.
function isRawGitFailure(e) {
  return e instanceof GitError && !(e instanceof GitNotFoundError) && (e.exitCode !== null || !!e.stderr);
}

/* Bir hatayı arayüze verilecek biçime çevirir: { code, error, gitDetail }.
 * Ham git hatasında error Türkçe özettir ve ham İngilizce başlık ya da mutlak yol içermez; gitDetail yalnızca git stderr'idir (arındırılmış).
 * Diğer hatalarda code null, error hatanın kendi iletisi, gitDetail boştur. Kimlik hatası (needIdentity) çağıranda ayrıca ele alınır. */
function explainGitError(e, roots = []) {
  if (!isRawGitFailure(e)) return { code: null, error: String((e && e.message) || tx('git.error.bilinmiyor')), gitDetail: '' };
  const code = classifyGitError(e.stderr, e);
  return { code, error: describeGitError(code), gitDetail: sanitizeDetail(e.stderr, roots) };
}

module.exports = { describeGitError, sanitizeDetail, explainGitError, isRawGitFailure, MAX_DETAIL };
