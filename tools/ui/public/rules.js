/* rules.js: yayın ve sürüm kuralları. Hem Node (require) hem tarayıcıda (window.Rules) çalışır.
 * Sunucu ve arayüz aynı kuralları paylaşır. Bağımlılığı fm.js'tir (tarayıcıda window.FM).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fm.js'));
  else root.Rules = factory(root.FM);
})(typeof self !== 'undefined' ? self : this, function (FM) {
  'use strict';

  const PUBLISH_FIELDS = ['paket', 'komut_adi', 'aciklama', 'arguman_ipucu', 'izinli_araclar', 'model'];
  const DEFAULT_VERSION = '1.0.0';
  const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

  const MSG = {
    turYok: function (fields) { return 'Yayın alanları dolu (' + fields.join(', ') + ') ama "tur" yok. Bu prompt yayınlanmayacak.'; },
    turGecersiz: function (val) { return '"tur" değeri tanınmadı: "' + val + '". Geçerli değerler: komut, ajan, skill. Bu prompt yayınlanmayacak.'; },
    onYuzKapanmamis: 'Frontmatter kapanmamış (ikinci "---" satırı yok). Alanlar okunamıyor, bu prompt yayınlanmayacak.',
    dosyaBuyuk: 'Dosya 2 MB\'tan büyük. Dizinlenmiyor ve yayınlanmıyor.',
    yayinDisi: 'Tür seçilmemiş (yayın dışı).',
    adUretilemedi: function (v) { return 'Ad üretilemedi ("' + v + '"), "adsiz" kullanılacak. "Ad" alanına harf veya rakam içeren bir değer yaz.'; }
  };

  function str(v) { return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v); }

  function normTur(v) {
    const t = FM.fold(str(v)).trim();
    if (['komut', 'command', 'slash'].includes(t)) return 'komut';
    if (['ajan', 'agent', 'subagent'].includes(t)) return 'ajan';
    if (['skill', 'beceri'].includes(t)) return 'skill';
    return '';
  }

  // "---" ile açılmış ama kapanmamış frontmatter.
  function isFmBroken(raw, hasFm) {
    return !hasFm && /^﻿?---[ \t]*\r?\n/.test(String(raw == null ? '' : raw));
  }

  function checkVersion(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return 'Sürüm boş olamaz (örnek: 1.0.0)';
    if (!SEMVER_RE.test(s)) return 'Sürüm X.Y.Z biçiminde olmalı (örnek: 1.0.0): "' + s + '"';
    return null;
  }

  function normalizeVersion(v) {
    const s = String(v == null ? '' : v).trim();
    return s || DEFAULT_VERSION;
  }

  // Yayına girmeyen prompt için neden. Yayına girebiliyorsa null.
  function publishCheck(o) {
    const meta = (o && o.meta) || {};
    if (o && o.fmBroken) return { code: 'onYuzKapanmamis', level: 'warn', reason: MSG.onYuzKapanmamis };
    if (normTur(meta.tur)) return null;
    const rawTur = str(meta.tur).trim();
    if (rawTur) return { code: 'turGecersiz', level: 'warn', reason: MSG.turGecersiz(rawTur) };
    const fields = PUBLISH_FIELDS.filter(function (k) {
      const v = meta[k];
      return !(v == null || v === '' || (Array.isArray(v) && v.length === 0));
    });
    if (fields.length) return { code: 'turYok', level: 'warn', reason: MSG.turYok(fields), fields: fields };
    return { code: 'yayinDisi', level: 'info', reason: MSG.yayinDisi };
  }

  return {
    normTur: normTur, PUBLISH_FIELDS: PUBLISH_FIELDS, publishCheck: publishCheck, isFmBroken: isFmBroken,
    DEFAULT_VERSION: DEFAULT_VERSION, SEMVER_RE: SEMVER_RE, checkVersion: checkVersion,
    normalizeVersion: normalizeVersion, MSG: MSG
  };
});
