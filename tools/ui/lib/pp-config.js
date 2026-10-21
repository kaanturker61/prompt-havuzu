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
const I18n = require('../public/i18n.js');
const paths = require('./paths');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

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

/** Summary: Tür kodundan sözlük anahtarına eşleme (null ve bilinmeyen typeof sonuçları olduğu gibi gösterilir). */
const TYPE_KEYS = Object.freeze({
  array: 'cfg.type.array',
  string: 'cfg.type.string',
  number: 'cfg.type.number',
  boolean: 'cfg.type.boolean',
  object: 'cfg.type.object'
});

/** Summary: Değerin dilden bağımsız tür kodu: null, array ya da typeof sonucu. */
function typeKind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Summary: Tür kodunun geçerli dildeki adı. */
function typeLabel(kind) {
  return Object.prototype.hasOwnProperty.call(TYPE_KEYS, kind) ? tx(TYPE_KEYS[kind]) : kind;
}

// Mutlak yol sızdırmamak için ham fs/JSON iletisi yerine kısa bir neden üretir.
function readReason(e) {
  if (e instanceof SyntaxError) return { code: 'json', detail: String(e.message).split('\n')[0].slice(0, 120) };
  return e && e.code ? { code: 'unreadableCode', errno: String(e.code) } : { code: 'unreadable' };
}

/** Summary: Okuma nedenini geçerli dilde metne çevirir. */
function reasonText(reason) {
  switch (reason.code) {
    case 'json': return tx('cfg.reason.json', { detail: reason.detail });
    case 'unreadableCode': return tx('cfg.reason.unreadableCode', { code: reason.errno });
    case 'notObject': return tx('cfg.reason.notObject', { type: typeLabel(reason.kind) });
    default: return tx('cfg.reason.unreadable');
  }
}

/** Summary: Uyarı üretir; message okunduğunda geçerli dilde üretilen tembel alıcıdır (önbelleğe giren kayıtta metin değil kod ve parametre kalır). */
function lazyIssue(code, build) {
  return { code, level: 'warn', get message() { return build(); } };
}

const bozukMsg = (why) => tx('cfg.bozuk', { reason: reasonText(why) });
const dirMsg = (raw, outside) => tx('cfg.libraryDirGecersiz', {
  field: 'libraryDir', fallback: DEFAULTS.libraryDir, reason: outside ? tx('cfg.outsideMarketplace') : Rules.parseLibraryDir(raw).error
});
const exportAlanMsg = (alan, kind) => tx('cfg.exportAlanGecersiz', {
  field: 'export.' + alan, type: typeLabel(kind), fallback: JSON.stringify(DEFAULTS.export[alan])
});
const exportMsg = (kind) => tx('cfg.exportGecersiz', {
  field: 'export', type: typeLabel(kind),
  defaults: `durumlar ${JSON.stringify(DEFAULTS.export.durumlar)}, haricKlasorler ${JSON.stringify(DEFAULTS.export.haricKlasorler)}`
});

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
        const why = readReason(e);
        issues.push(lazyIssue('ppConfigBozuk', () => bozukMsg(why)));
      }
    }
    if (text !== null) {
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      let parsed;
      let why = null;
      try { parsed = JSON.parse(text); } catch (e) { why = readReason(e); }
      if (why === null && !isPlain(parsed)) why = { code: 'notObject', kind: typeKind(parsed) };
      if (why === null) { c = parsed; state = 'ok'; } else {
        state = 'bozuk';
        const found = why;
        issues.push(lazyIssue('ppConfigBozuk', () => bozukMsg(found)));
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
    let bad = !!p.error;
    let outside = false;
    // Sözdizimi geçerli olsa da gerçek yol (bağlantılar çözülerek) marketplace klasörünün içinde kalmalı.
    if (!bad && dir && !paths.isInside(path.join(dir, p.value), dir)) { bad = true; outside = true; }
    if (bad) {
      const raw = c.libraryDir;
      issues.push(lazyIssue('libraryDirGecersiz', () => dirMsg(raw, outside)));
    } else libraryDir = p.value;
  }
  // Anahtar var ama tipi yanlışsa uyar (anahtar yoksa varsayılan sessizce geçerlidir). Yalnızca uyarı: yazmayı engellemez.
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  if (has(c, 'export') && !isPlain(c.export)) {
    const kind = typeKind(c.export);
    issues.push(lazyIssue('exportAlanGecersiz', () => exportMsg(kind)));
  } else {
    for (const alan of ['durumlar', 'haricKlasorler']) {
      if (has(ex, alan) && !Array.isArray(ex[alan])) {
        const kind = typeKind(ex[alan]);
        issues.push(lazyIssue('exportAlanGecersiz', () => exportAlanMsg(alan, kind)));
      }
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
