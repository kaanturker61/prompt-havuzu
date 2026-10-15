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
  // Her bileşen en çok 9 basamak (999999999): Number ile kayıpsız karşılaştırılır, BigInt gerekmez.
  const VERSION_PART_MAX = 999999999;
  const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
  const SEMVER_ANY_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

  const MSG = {
    turYok: function (fields) { return 'Yayın alanları dolu (' + fields.join(', ') + ') ama "tur" yok. Bu prompt yayınlanmayacak.'; },
    turGecersiz: function (val) { return '"tur" değeri tanınmadı: "' + val + '". Geçerli değerler: komut, ajan, skill. Bu prompt yayınlanmayacak.'; },
    onYuzKapanmamis: 'Frontmatter kapanmamış (ikinci "---" satırı yok). Alanlar okunamıyor, bu prompt yayınlanmayacak.',
    dosyaBuyuk: 'Dosya 2 MB\'tan büyük. Dizinlenmiyor ve yayınlanmıyor.',
    yayinDisi: 'Tür seçilmemiş (yayın dışı).',
    surumGuncelDegil: function (v) { return 'Son sürümden (v' + v + ') beri dosya değişti ama versiyon aynı. Yeni sürüm için +1\'e bas.'; },
    adUretilemedi: function (v) { return 'Ad üretilemedi ("' + v + '"), "adsiz" kullanılacak. "Ad" alanına harf veya rakam içeren bir değer yaz.'; },
    paketUyusmuyor: function (klasor, alan) {
      return 'Dosya "' + klasor + '" paketinin klasöründe ama "paket" alanı "' + alan + '". Paket klasörden alınır; alanı düzelt ya da dosyayı taşı.';
    },
    paketCokDegerli: '"paket" tek bir değer olmalı.',
    durumHaric: function (durum, liste) {
      const l = liste.map(function (x) { return x === '' ? '(boş)' : x; }).join(', ');
      return (durum ? 'Durumu "' + durum + '".' : 'Durumu boş.') + ' Yalnızca şu durumlar dışa aktarılır: ' + l + '.';
    },
    surumArtirilmamis: function (v) { return 'İçerik değişmiş ama "versiyon" artırılmamış (' + v + '). Yama sayılacak.'; },
    // list: FM.duplicateKeys sonucu [{ key, count }] (düz anahtar adı da kabul edilir)
    anahtarTekrar: function (list) {
      const d = (list || []).map(function (x) { return typeof x === 'string' ? { key: x, count: 2 } : x; });
      if (d.length === 1) return d[0].key + ' ' + d[0].count + ' kez yazılmış; sonuncusu geçerli.';
      return d.map(function (x) { return x.key + ' (' + x.count + ' kez)'; }).join(', ') + ' birden fazla kez yazılmış; hepsinde sonuncusu geçerli.';
    },
    aygitAdi: function (ad) { return '"' + ad + '" bir Windows aygıt adı; dosya, klasör veya plugin adı olarak kullanılamaz. Başka bir ad seç.'; }
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
    if (!SEMVER_RE.test(s)) {
      if (SEMVER_ANY_RE.test(s)) return 'Sürüm bileşenleri en çok 9 basamak olabilir: "' + s + '"';
      return 'Sürüm X.Y.Z biçiminde olmalı (örnek: 1.0.0): "' + s + '"';
    }
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
    // Baştaki sıfırlar atılır; 9 basamağı aşan bileşen yorumlanamaz (parseInt/Number kayıplı olurdu).
    const parts = [m[1], m[2] || '0', m[3] || '0'].map(function (x) { return x.replace(/^0+(?=\d)/, ''); });
    if (parts.some(function (x) { return x.length > 9; })) return null;
    return { version: parts.join('.'), legacy: true };
  }

  // v boşsa DEFAULT_VERSION döner. Yorumlanamazsa, seviye geçersizse veya bir bileşen 999999999'u aşacaksa null.
  function bumpVersion(v, level) {
    if (VERSION_LEVELS.indexOf(level) < 0) return null;
    const c = coerceVersion(v);
    if (!c) return null;
    if (!c.version) return DEFAULT_VERSION;
    const n = c.version.split('.').map(Number);
    let out;
    if (level === 'buyuk') out = [n[0] + 1, 0, 0];
    else if (level === 'kucuk') out = [n[0], n[1] + 1, 0];
    else out = [n[0], n[1], n[2] + 1];
    if (out.some(function (x) { return x > VERSION_PART_MAX; })) return null;
    return out.join('.');
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

  /* ---- plugin (klasör) adı kuralları ---- */

  const INBOX_DIR = 'gelen-kutusu';
  // server.js IGNORE kümesiyle aynı içerikte olmalı (testle denetlenir).
  const RESERVED_DIRS = ['tools', 'node_modules', '.pp', '.git'];
  const BAD_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-'];
  const BAD_NAMES = ['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods'];

  // Geçerliyse null, değilse Türkçe hata iletisi.
  function checkPluginName(slug) {
    const n = String(slug == null ? '' : slug).trim().toLowerCase();
    if (!n) return 'Plugin adı gerekli';
    if (isDeviceName(n)) return MSG.aygitAdi(n);
    if (n === INBOX_DIR) return '"' + INBOX_DIR + '" içe aktarma klasörüne ayrılmış. Başka bir ad seç.';
    if (RESERVED_DIRS.indexOf(n) >= 0) return '"' + n + '" adı sistemde ayrılmış. Başka bir ad seç.';
    const official = /(^|-)(claude|anthropic)-official(-|$)|(^|-)official-(claude|anthropic)(-|$)/.test(n);
    if (BAD_NAMES.indexOf(n) >= 0 || BAD_PREFIXES.some(function (p) { return n.indexOf(p) === 0; }) || official) {
      return '"' + n + '" adı Anthropic\'e ayrılmış (claude-, anthropic-, anthropics-, cc-plugin- ile başlayamaz; claude, anthropic, claude-code gibi adlar kullanılamaz). Başka bir ad seç.';
    }
    return null;
  }

  // Engellemeyen uyarı. Yoksa null.
  function pluginNameWarn(slug) {
    const n = String(slug == null ? '' : slug).trim().toLowerCase();
    const m = /(?:^|-)(claude|anthropic)(?:-|$)/.exec(n);
    if (m) return '"' + n + '" içinde "' + m[1] + '" kelimesi geçiyor; Claude Code bunu uyarıyla kabul eder.';
    if (n.length > 128) return 'Plugin adı 128 karakterden uzun; Claude Desktop kabul etmeyebilir.';
    return null;
  }

  /* ---- dosya/klasör adı kuralları (yeni oluşturulan adlar için) ---- */

  const MAX_NAME_BYTES = 200;
  const DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$/;

  // Windows aygıt adı mı? `.` öncesi gövdeye bakılır (CON, nul.txt, Com1.md); işletim sisteminden bağımsız uygulanır.
  function isDeviceName(ad) {
    const body = String(ad == null ? '' : ad).split('.')[0].replace(/[ ]+$/, '').toUpperCase();
    return DEVICE_RE.test(body);
  }

  // Yeni bir dosya ya da klasörün son yol bileşeni için. Geçerliyse null, değilse Türkçe hata iletisi.
  function checkEntryName(ad) {
    const s = String(ad == null ? '' : ad);
    if (!s) return 'Ad boş olamaz';
    if (s === '.' || s === '..') return 'Ad "." ya da ".." olamaz';
    if (new TextEncoder().encode(s).length > MAX_NAME_BYTES) return 'Ad en çok ' + MAX_NAME_BYTES + ' bayt olabilir';
    if (/[\x00-\x1f\x7f<>:"|?*]/.test(s)) return 'Ad şu karakterleri içeremez: < > : " | ? * ve kontrol karakterleri';
    if (/[. ]$/.test(s)) return 'Ad nokta ya da boşlukla bitemez';
    if (isDeviceName(s)) return MSG.aygitAdi(s);
    return null;
  }

  // Marketplace yapısının parçası olan, silinemez ve taşınamaz yollar (marketplace köküne göreli, büyük-küçük harf duyarsız).
  const PROTECTED_ROOT = ['pp.config.json', 'plugins', '.claude-plugin', '.gitignore', '.gitattributes'];

  /* rel silinemez/taşınamaz mı? Kök düzeyinde tam eşleşme: libraryDir (iç içeyse üst klasörleri de), pp.config.json, plugins,
   * .claude-plugin, .gitignore, .gitattributes; .pp altındaki her yol. İçerikleri (plugins/<paket>, prompts/x.md) korunmaz.
   * Windows'ta sondaki nokta/boşluk yok sayıldığı için bileşenlerden atılır. */
  function isProtectedPath(rel, libraryDir) {
    const parts = String(rel == null ? '' : rel).replace(/\\/g, '/').split('/').filter(Boolean)
      .map(function (p) { return p.replace(/[. ]+$/, '').toLowerCase(); });
    if (!parts.length) return false;
    if (parts[0] === '.pp') return true;
    if (parts.length === 1 && PROTECTED_ROOT.indexOf(parts[0]) >= 0) return true;
    const lib = parseLibraryDir(libraryDir).value;
    if (lib) {
      const lp = lib.toLowerCase().split('/');
      if (parts.length <= lp.length && parts.every(function (p, i) { return p === lp[i]; })) return true;
    }
    return false;
  }

  /* ---- libraryDir (pp.config.json) kuralları ---- */

  // libraryDir olarak kullanılamayan ad parçaları (RESERVED_DIRS'ten ayrı: o küme ağaç/arama yürüyüşünün yok saydıklarıdır).
  const LIBRARY_DIR_RESERVED = ['.git', '.pp', '.claude-plugin', 'plugins'];

  /* Ham `libraryDir` değerini marketplace köküne göreli kanonik yola çevirir.
   * Dönüş: { value, error }. Geçerliyse error null; değilse value null ve error kısa bir Türkçe neden.
   * Yalnızca sözdizimi denetlenir; gerçek yol (bağlantı) denetimi lib/pp-config.js'te yapılır. */
  function parseLibraryDir(v) {
    const bad = function (why) { return { value: null, error: why }; };
    if (typeof v !== 'string') return bad('metin olmalı');
    let s = v.trim().replace(/\\/g, '/');
    while (s.indexOf('./') === 0) s = s.slice(2);
    s = s.replace(/\/+$/, '');
    if (!s) return bad('boş olamaz');
    if (s.charAt(0) === '/' || /^[A-Za-z]:/.test(s)) return bad('mutlak yol olamaz (marketplace klasörüne göreli olmalı)');
    if (/[\x00-\x1f\x7f]/.test(s) || /[<>:"|?*]/.test(s)) return bad('geçersiz karakter içeriyor');
    const parts = s.split('/');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '..') return bad('".." içeremez');
      if (p === '' || p === '.') return bad('boş ya da "." bileşeni içeremez');
      if (/[. ]$/.test(p)) return bad('bir bileşen nokta ya da boşlukla bitemez: "' + p + '"');
      if (LIBRARY_DIR_RESERVED.indexOf(p.toLowerCase()) >= 0) return bad('"' + p + '" adı ayrılmış');
    }
    return { value: parts.join('/'), error: null };
  }

  // Prompt yolunun marketplace içindeki yeri. Kural tek yerde burada.
  function classifyPromptPath(rel, libraryDir) {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const lib = String(libraryDir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const none = { kind: 'disarida', klasor: null, paket: null };
    if (!lib || r.indexOf(lib + '/') !== 0) return none;
    const parts = r.slice(lib.length + 1).split('/').filter(Boolean);
    if (!parts.length) return none;
    if (parts.length === 1) return { kind: 'klasorsuz', klasor: null, paket: null };
    if (parts[0] === INBOX_DIR) return { kind: 'gelenKutusu', klasor: INBOX_DIR, paket: null };
    if (parts[0].charAt(0) === '.') return none;
    return { kind: 'paket', klasor: parts[0], paket: FM.slug(parts[0]) };
  }

  /* ---- Aşama 4: paket, dışa aktarma ve uzak depo kuralları ---- */

  const PACKAGE_TAG_PREFIX = 'paket/';
  const PACKAGE_TAG_RE = /^paket\/(.+)\/v(\d+\.\d+\.\d+)$/;

  // Artış seviyesi: 'buyuk'|'kucuk'|'yama'. Artış yoksa, geriye gidiş veya yorumlanamazsa null.
  function levelBetween(oldV, newV) {
    const a = coerceVersion(oldV); const b = coerceVersion(newV);
    if (!a || !b || !b.version) return null;
    if (!a.version) return 'kucuk';
    if (compareVersions(b.version, a.version) <= 0) return null;
    const x = a.version.split('.').map(Number); const y = b.version.split('.').map(Number);
    if (y[0] > x[0]) return 'buyuk';
    if (y[1] > x[1]) return 'kucuk';
    return 'yama';
  }

  function maxLevel(levels) {
    let best = -1;
    (levels || []).forEach(function (l) {
      const i = VERSION_LEVELS.indexOf(l);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    });
    return best < 0 ? null : VERSION_LEVELS[best];
  }

  function packageTag(ad, v) { return PACKAGE_TAG_PREFIX + ad + '/v' + v; }

  function parsePackageTag(name) {
    const m = PACKAGE_TAG_RE.exec(String(name));
    if (!m || !SEMVER_RE.test(m[2]) || m[1].indexOf('/') >= 0) return null;
    return { ad: m[1], version: m[2] };
  }

  /* Bir promptun hangi pakete gireceği. Paket klasörden alınır; `paket` alanı yalnızca klasörsüz promptlarda geçerlidir.
   * Dönüş: { paket|null, kaynak: 'klasor'|'alan'|'varsayilan'|null, code?, level? } */
  function resolvePackage(o) {
    const cl = classifyPromptPath(o.rel, o.libraryDir);
    const alanRaw = o.metaPaket;
    const liste = Array.isArray(alanRaw) ? alanRaw.map(String).filter(Boolean) : null;
    const alan = liste ? liste.join(', ') : (alanRaw == null ? '' : String(alanRaw).trim());
    const haric = (o.haricKlasorler || []).map(function (x) { return FM.slug(x); });
    if (cl.kind === 'disarida') return { paket: null, kaynak: null, code: 'kutuphaneDisi', level: 'info' };
    if (cl.kind === 'gelenKutusu') return { paket: null, kaynak: 'klasor', code: 'paketDisiKlasor', level: 'info' };
    if (cl.kind === 'paket') {
      if (haric.indexOf(cl.paket) >= 0) return { paket: null, kaynak: 'klasor', code: 'paketDisiKlasor', level: 'info' };
      if (liste && liste.length > 1) return { paket: cl.paket, kaynak: 'klasor', code: 'paketCokDegerli', level: 'warn' };
      if (alan && FM.slug(alan) !== cl.paket) return { paket: cl.paket, kaynak: 'klasor', code: 'paketUyusmuyor', level: 'warn', alan: alan, klasor: cl.klasor };
      return { paket: cl.paket, kaynak: 'klasor' };
    }
    // klasörsüz
    if (liste && liste.length > 1) return { paket: null, kaynak: 'alan', code: 'paketCokDegerli', level: 'warn' };
    if (alan) return { paket: FM.slug(alan), kaynak: 'alan' };
    return { paket: o.defaultPaket ? FM.slug(o.defaultPaket) : null, kaynak: 'varsayilan', code: 'paketKlasoruYok', level: 'info' };
  }

  // durumlar: ['kararlı', ''] ('' = durumu boş). Türkçe karakter ve büyük-küçük harf yok sayılır.
  function durumAllowed(durum, durumlar) {
    const k = FM.fold(str(durum)).trim();
    return (durumlar || []).some(function (d) { return FM.fold(str(d)).trim() === k; });
  }

  const MP_OFFICIAL = ['claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'anthropic-marketplace',
    'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills', 'life-sciences', 'knowledge-work-plugins', 'claude-for-legal',
    'claude-for-financial-services', 'financial-services-plugins', 'first-party-plugins', 'claude-tag-plugins'];
  const MP_COMMUNITY = ['claude-community', 'claude-plugins-community', 'healthcare', 'anthropic-plugin-directory', 'claude-plugin-directory'];
  const MP_INTERNAL = ['inline', 'builtin', 'skills-dir', 'synced', 'claude-plugin-test'];
  const MP_SHORT = ['npm', 'pip', 'uv', 'cargo', 'github', 'gh'];

  function mpKey(n) { return String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  // Geçerliyse null, değilse Türkçe hata iletisi.
  function checkMarketplaceName(n) {
    const raw = String(n == null ? '' : n).trim();
    if (!raw) return 'Marketplace adı gerekli';
    if (raw.length > 128) return 'Marketplace adı 128 karakterden uzun olamaz';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) || raw.indexOf('..') >= 0) {
      return 'Marketplace adı harf ya da rakamla başlamalı; yalnızca harf, rakam, ".", "_" ve "-" içerebilir: ' + raw;
    }
    // Klasör adı olacağı için: Windows sondaki noktayı sessizce atar (yazılan ad ile klasör adı ayrışır) ve aygıt adlarını kabul etmez.
    if (/\.$/.test(raw)) return 'Marketplace adı nokta ile bitemez: ' + raw;
    if (isDeviceName(raw)) return MSG.aygitAdi(raw);
    const k = mpKey(raw);
    if (MP_OFFICIAL.indexOf(k) >= 0 || /^claudeai-/.test(k)) return "Bu ad resmi Anthropic marketplace'lerine ayrılmış: " + raw;
    if (MP_COMMUNITY.indexOf(k) >= 0) return 'Bu ad Claude dizinlerine ayrılmış: ' + raw;
    if (MP_INTERNAL.indexOf(k) >= 0 || MP_SHORT.indexOf(k) >= 0) return 'Bu ad Claude Code tarafından ayrılmış: ' + raw;
    return null;
  }

  function checkRemoteName(n) {
    const s = String(n == null ? '' : n).trim();
    if (!s) return 'Uzak depo adı gerekli';
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) || s.indexOf('..') >= 0 || /\.lock$/.test(s)) {
      return 'Uzak depo adı küçük harf, rakam, ".", "_" ve "-" içermeli, harf ya da rakamla başlamalı (en çok 64 karakter)';
    }
    return null;
  }

  function isAbsLocal(u) { return /^\//.test(u) || /^[A-Za-z]:[\\/]/.test(u) || /^\\\\[^\\]/.test(u); }

  const MAX_URL_LENGTH = 2048;
  const URL_TOO_LONG = 'URL en çok ' + MAX_URL_LENGTH + ' karakter olabilir';

  function checkRemoteUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return 'URL gerekli';
    if (s.length > MAX_URL_LENGTH) return URL_TOO_LONG; // regex'lerden önce: çok uzun girdi hızlıca reddedilir
    if (s.charAt(0) === '-') return 'URL "-" ile başlayamaz';
    if (/^[A-Za-z0-9+.-]+::/.test(s)) return 'Bu bağlantı türü güvenlik nedeniyle kapalı';
    if (/[\x00-\x1f\x7f]/.test(s)) return 'URL boşluk veya kontrol karakteri içeremez';
    if (/\s/.test(s) && !isAbsLocal(s)) return 'URL boşluk veya kontrol karakteri içeremez';
    if (/^http:\/\//i.test(s)) return 'Şifresiz http kullanılmaz, https kullan';
    if (/^https:\/\//i.test(s)) {
      const m = /^https:\/\/([^/]*)(\/.*)?$/i.exec(s);
      if (!m || !m[1]) return 'URL geçersiz';
      if (m[1].indexOf('@') >= 0) return "Parola veya token URL'ye yazılmaz (düz metin olarak .git/config'e kaydedilir). Credential manager kullan.";
      if (!m[2] || m[2] === '/') return 'URL depo yolunu içermeli (örnek: https://github.com/kullanıcı/depo)';
      return null;
    }
    if (/^ssh:\/\/([^/@\s]+@)?[^/\s:]+(:\d+)?\/\S+/i.test(s)) return null;
    if (/^file:\/\/\/\S+/i.test(s)) return null;
    if (/^[\w.-]+@[\w.-]+:\S+$/.test(s)) return null;
    if (isAbsLocal(s)) return null;
    return 'Mutlak bir yol ya da URL gir';
  }

  function repoProvider(url) {
    const s = String(url || '');
    let host = '';
    let m = /^(?:https:\/\/|ssh:\/\/)(?:[^@/]+@)?([^/:]+)/i.exec(s);
    if (m) host = m[1];
    else if ((m = /^[\w.-]+@([\w.-]+):/.exec(s))) host = m[1];
    host = host.toLowerCase();
    if (host === 'github.com') return 'github';
    if (host === 'gitlab.com' || host.indexOf('gitlab.') === 0) return 'gitlab';
    return 'diger';
  }

  // Form girdisini (kısaltma, tarayıcı linki, URL) git URL'sine çevirir. { url, provider, slugName } | { error }
  function normalizeRepoUrl(input) {
    let s = String(input == null ? '' : input).trim();
    if (s.length > MAX_URL_LENGTH) return { error: URL_TOO_LONG }; // regex'lerden önce
    s = s.replace(/\/+$/, '');
    if (!s) return { error: 'URL gerekli' };
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) && s.charAt(0) !== '.') {
      s = 'https://github.com/' + s + '.git';
    } else if (/^https:\/\//i.test(s)) {
      const m = /^(https:\/\/)(?:www\.)?(github\.com)\/([^/]+)\/([^/]+)/i.exec(s);
      if (m) s = m[1] + m[2] + '/' + m[3] + '/' + m[4].replace(/\.git$/i, '') + '.git';
      else {
        const cut = s.indexOf('/-/');
        if (cut > 0) s = s.slice(0, cut).replace(/\/+$/, '');
        if (!/\.git$/i.test(s)) s += '.git';
      }
    }
    const err = checkRemoteUrl(s);
    if (err) return { error: err };
    const last = s.split(/[\\/:]/).filter(Boolean).pop() || '';
    return { url: s, provider: repoProvider(s), slugName: FM.slug(last.replace(/\.git$/i, '')) };
  }

  // { primary, alternatives[] }: `claude plugin marketplace add` girdileri.
  function marketplaceAddCommand(url) {
    const s = String(url || '');
    if (repoProvider(s) === 'github') {
      const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(s);
      if (m) return { primary: m[1] + '/' + m[2], alternatives: [s] };
    }
    return { primary: s, alternatives: [] };
  }

  return {
    PACKAGE_TAG_PREFIX: PACKAGE_TAG_PREFIX, levelBetween: levelBetween, maxLevel: maxLevel,
    packageTag: packageTag, parsePackageTag: parsePackageTag, resolvePackage: resolvePackage, durumAllowed: durumAllowed,
    checkMarketplaceName: checkMarketplaceName, checkRemoteName: checkRemoteName, checkRemoteUrl: checkRemoteUrl,
    normalizeRepoUrl: normalizeRepoUrl, repoProvider: repoProvider, marketplaceAddCommand: marketplaceAddCommand,
    INBOX_DIR: INBOX_DIR, RESERVED_DIRS: RESERVED_DIRS, checkPluginName: checkPluginName,
    LIBRARY_DIR_RESERVED: LIBRARY_DIR_RESERVED, parseLibraryDir: parseLibraryDir,
    MAX_NAME_BYTES: MAX_NAME_BYTES, isDeviceName: isDeviceName, checkEntryName: checkEntryName, isProtectedPath: isProtectedPath,
    pluginNameWarn: pluginNameWarn, classifyPromptPath: classifyPromptPath,
    normTur: normTur, PUBLISH_FIELDS: PUBLISH_FIELDS, publishCheck: publishCheck, isFmBroken: isFmBroken,
    DEFAULT_VERSION: DEFAULT_VERSION, SEMVER_RE: SEMVER_RE, VERSION_PART_MAX: VERSION_PART_MAX, MAX_URL_LENGTH: MAX_URL_LENGTH, checkVersion: checkVersion,
    normalizeVersion: normalizeVersion, MSG: MSG,
    VERSION_LEVELS: VERSION_LEVELS, LEVEL_LABEL: LEVEL_LABEL, PROMPT_TAG_PREFIX: PROMPT_TAG_PREFIX,
    coerceVersion: coerceVersion, bumpVersion: bumpVersion, compareVersions: compareVersions,
    promptTagAd: promptTagAd, promptTag: promptTag, parsePromptTag: parsePromptTag
  };
});
