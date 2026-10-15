'use strict';
/* Marketplace klasöründeki pp.config.json okuma/yazma. Kök parametreli olduğu için her marketplace için çalışır.
 *
 * Okuma yumuşaktır: bozuk dosya, geçersiz libraryDir ya da tipi yanlış export alanı uyarıya (issues) dönüşür, varsayılan ayarlar kullanılır.
 * Yazma sertir: dosya bozukken ya da libraryDir geçersizken yazan her işlem PpConfigError (409) ile reddedilir,
 * böylece varsayılanlar kullanıcının bozuk ama kurtarılabilir dosyasının üstüne yazılmaz.
 * Tipi yanlış export alanı yalnızca uyarıdır (exportAlanGecersiz): yazmayı engellemez, state 'bozuk' olmaz. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Rules = require('../public/rules.js');
const paths = require('./paths');

const DEFAULTS = {
  libraryDir: 'library',
  marketplace: { name: 'prompt-havuzu', owner: '', plugin: 'benim-promptlarim', description: 'Kişisel prompt havuzu', version: Rules.DEFAULT_VERSION },
  packages: {},
  export: { durumlar: ['kararlı', ''], haricKlasorler: [Rules.INBOX_DIR] }
};

const configFileAt = (dir) => path.join(dir, 'pp.config.json');

class PpConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PpConfigError';
    this.status = 409;
    this.data = { code };
  }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeLabel(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'dizi';
  return { string: 'metin', number: 'sayı', boolean: 'mantıksal değer', object: 'nesne' }[typeof v] || typeof v;
}

// Mutlak yol sızdırmamak için ham fs/JSON iletisi yerine kısa bir neden üretir.
function readReason(e) {
  if (e instanceof SyntaxError) return 'JSON biçimi geçersiz: ' + String(e.message).split('\n')[0].slice(0, 120);
  return 'dosya okunamadı' + (e && e.code ? ' (' + e.code + ')' : '');
}

const bozukMsg = (why) => `pp.config.json okunamadı (${why}). Geçici olarak varsayılan ayarlar kullanılıyor ve yazma işlemleri kapalı. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin), sonra yeniden dene.`;
const dirMsg = (why) => `pp.config.json içindeki "libraryDir" geçersiz (${why}). Geçici olarak "${DEFAULTS.libraryDir}" kullanılıyor ve yazma işlemleri kapalı. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin), sonra yeniden dene.`;
const exportAlanMsg = (alan, v) => `pp.config.json içindeki "export.${alan}" dizi olmalı (şu an: ${typeLabel(v)}). Bu alan için varsayılan kullanılıyor: ${JSON.stringify(DEFAULTS.export[alan])}. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin).`;
const exportMsg = (v) => `pp.config.json içindeki "export" nesne olmalı (şu an: ${typeLabel(v)}). Dışa aktarma için varsayılanlar kullanılıyor: durumlar ${JSON.stringify(DEFAULTS.export.durumlar)}, haricKlasorler ${JSON.stringify(DEFAULTS.export.haricKlasorler)}. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin).`;

/* Ayarı okur ve sağlığını değerlendirir. Diske yazmaz.
 * Dönüş: { cfg, state: 'yok'|'ok'|'bozuk', issues: [{ code, level: 'warn', message }] }.
 * cfg her zaman kullanılabilir bir ayardır (bozuk/geçersiz parçalar varsayılana düşer).
 * export nesnesi ya da durumlar/haricKlasorler dizisi tipi yanlışsa exportAlanGecersiz (warn) eklenir; state değişmez. */
async function inspectConfigAt(dir) {
  const issues = [];
  let c = {};
  let state = 'yok';
  if (dir) {
    let text = null;
    try { text = await fsp.readFile(configFileAt(dir), 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
        state = 'bozuk';
        issues.push({ code: 'ppConfigBozuk', level: 'warn', message: bozukMsg(readReason(e)) });
      }
    }
    if (text !== null) {
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      let parsed;
      let why = null;
      try { parsed = JSON.parse(text); } catch (e) { why = readReason(e); }
      if (why === null && !isPlain(parsed)) why = 'kök bir nesne değil, ' + typeLabel(parsed);
      if (why === null) { c = parsed; state = 'ok'; } else {
        state = 'bozuk';
        issues.push({ code: 'ppConfigBozuk', level: 'warn', message: bozukMsg(why) });
      }
    }
  }
  const marketplace = { ...DEFAULTS.marketplace, ...(isPlain(c.marketplace) ? c.marketplace : {}) };
  marketplace.version = Rules.normalizeVersion(marketplace.version);
  const ex = isPlain(c.export) ? c.export : {};
  const exp = {
    durumlar: Array.isArray(ex.durumlar) ? ex.durumlar.map((x) => String(x == null ? '' : x)) : DEFAULTS.export.durumlar.slice(),
    haricKlasorler: Array.isArray(ex.haricKlasorler) ? ex.haricKlasorler.map(String).filter(Boolean) : DEFAULTS.export.haricKlasorler.slice()
  };
  let libraryDir = DEFAULTS.libraryDir;
  if (Object.prototype.hasOwnProperty.call(c, 'libraryDir')) {
    const p = Rules.parseLibraryDir(c.libraryDir);
    let err = p.error;
    // Sözdizimi geçerli olsa da gerçek yol (bağlantılar çözülerek) marketplace klasörünün içinde kalmalı.
    if (!err && dir && !paths.isInside(path.join(dir, p.value), dir)) err = "marketplace klasörünün dışına çıkıyor (bir bağlantı olabilir)";
    if (err) issues.push({ code: 'libraryDirGecersiz', level: 'warn', message: dirMsg(err) });
    else libraryDir = p.value;
  }
  // Anahtar var ama tipi yanlışsa uyar (anahtar yoksa varsayılan sessizce geçerlidir). Yalnızca uyarı: yazmayı engellemez.
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  if (has(c, 'export') && !isPlain(c.export)) {
    issues.push({ code: 'exportAlanGecersiz', level: 'warn', message: exportMsg(c.export) });
  } else {
    for (const alan of ['durumlar', 'haricKlasorler']) {
      if (has(ex, alan) && !Array.isArray(ex[alan])) issues.push({ code: 'exportAlanGecersiz', level: 'warn', message: exportAlanMsg(alan, ex[alan]) });
    }
  }
  const cfg = { ...DEFAULTS, ...c, libraryDir, marketplace, packages: isPlain(c.packages) ? { ...c.packages } : {}, export: exp };
  return { cfg, state, issues };
}

// dir yoksa veya dosya okunamıyorsa varsayılanlar. Okurken diske yazılmaz.
async function loadConfigAt(dir) {
  return (await inspectConfigAt(dir)).cfg;
}

/* Yazan işlemlerin ön koşulu: dosya ayrıştırılabilir olmalı ve libraryDir geçerli olmalı.
 * Aksi halde PpConfigError (409). Sağlamsa inspectConfigAt sonucunu döndürür. */
async function assertHealthy(dir) {
  const r = await inspectConfigAt(dir);
  const bad = r.issues.find((i) => i.code === 'ppConfigBozuk') || r.issues.find((i) => i.code === 'libraryDirGecersiz');
  if (bad) throw new PpConfigError(bad.code, bad.message);
  return r;
}

async function saveConfigAt(dir, c, atomicWrite) {
  await assertHealthy(dir);
  await atomicWrite(configFileAt(dir), JSON.stringify(c, null, 2) + '\n');
}

module.exports = { DEFAULTS, configFileAt, loadConfigAt, saveConfigAt, inspectConfigAt, assertHealthy, PpConfigError };
