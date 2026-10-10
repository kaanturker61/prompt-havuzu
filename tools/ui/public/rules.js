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
    surumGuncelDegil: function (v) { return 'Son sürümden (v' + v + ') beri dosya değişti ama versiyon aynı. Yeni sürüm için +1\'e bas.'; },
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

  /* ---- prompt sürümü ve tag kuralları (Aşama 2) ---- */

  const VERSION_LEVELS = ['buyuk', 'kucuk', 'yama'];
  const LEVEL_LABEL = { buyuk: 'Büyük', kucuk: 'Küçük', yama: 'Yama' };
  const PROMPT_TAG_PREFIX = 'prompt/';
  const LEGACY_VER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
  const PROMPT_TAG_RE = /^prompt\/(.+)\/v(\d+\.\d+\.\d+)$/;

  // Ham `versiyon` değerini yorumlar. Alan boşsa { version: '' }, yorumlanamazsa null.
  function coerceVersion(v) {
    if (Array.isArray(v)) return null;
    const s = String(v == null ? '' : v).trim();
    if (!s) return { version: '', legacy: false };
    if (SEMVER_RE.test(s)) return { version: s, legacy: false };
    const m = LEGACY_VER_RE.exec(s);
    if (!m) return null;
    return { version: [m[1], m[2] || '0', m[3] || '0'].map(function (x) { return String(parseInt(x, 10)); }).join('.'), legacy: true };
  }

  // v boşsa DEFAULT_VERSION döner. Yorumlanamazsa veya seviye geçersizse null.
  function bumpVersion(v, level) {
    if (VERSION_LEVELS.indexOf(level) < 0) return null;
    const c = coerceVersion(v);
    if (!c) return null;
    if (!c.version) return DEFAULT_VERSION;
    const n = c.version.split('.').map(Number);
    if (level === 'buyuk') return (n[0] + 1) + '.0.0';
    if (level === 'kucuk') return n[0] + '.' + (n[1] + 1) + '.0';
    return n[0] + '.' + n[1] + '.' + (n[2] + 1);
  }

  function compareVersions(a, b) {
    const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    }
    return 0;
  }

  // 'prompts/Örnek/Merhaba Dünya.md' -> 'ornek/merhaba-dunya'. Kitaplık dışındaysa null.
  function promptTagAd(rel, libraryDir) {
    const r = String(rel || '').replace(/\\/g, '/');
    const lib = String(libraryDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!lib || r.indexOf(lib + '/') !== 0) return null;
    const rest = r.slice(lib.length + 1).replace(/\.(md|markdown)$/i, '');
    if (!rest) return null;
    return rest.split('/').map(function (part) { return FM.slug(part); }).join('/');
  }

  function promptTag(ad, version) { return PROMPT_TAG_PREFIX + ad + '/v' + version; }

  function parsePromptTag(name) {
    const m = PROMPT_TAG_RE.exec(String(name));
    if (!m || !SEMVER_RE.test(m[2])) return null;
    return { ad: m[1], version: m[2] };
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
    normalizeVersion: normalizeVersion, MSG: MSG,
    VERSION_LEVELS: VERSION_LEVELS, LEVEL_LABEL: LEVEL_LABEL, PROMPT_TAG_PREFIX: PROMPT_TAG_PREFIX,
    coerceVersion: coerceVersion, bumpVersion: bumpVersion, compareVersions: compareVersions,
    promptTagAd: promptTagAd, promptTag: promptTag, parsePromptTag: parsePromptTag
  };
});
