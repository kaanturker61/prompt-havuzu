'use strict';

const path = require('path');
const I18n = require('../public/i18n.js');
const paths = require('./paths');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

/** Summary: Eski ayar dosyasının marketplace köküne göreli adı; artık okunmaz, yalnızca varlığı denetlenir. */
const LEGACY_FILE = 'pp.config.json';

/** Summary: Tür kodundan sözlük anahtarına eşleme (null ve bilinmeyen typeof sonuçları olduğu gibi gösterilir). */
const TYPE_KEYS = Object.freeze({
  array: 'cfg.type.array',
  string: 'cfg.type.string',
  number: 'cfg.type.number',
  boolean: 'cfg.type.boolean',
  object: 'cfg.type.object'
});

/** Summary: Değer, dizi olmayan bir nesne mi. */
function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Summary: Değer metinse kırpılmış hali, değilse boş metin. */
function trimmedText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

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

/** Summary: Okuma hatasından dilden bağımsız, mutlak yol içermeyen kısa bir neden kodu üretir. */
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

/** Summary: Uyarı üretir; message okunduğunda geçerli dilde üretilen tembel alıcıdır, file mutlak yoldur. */
function lazyIssue(code, file, build) {
  return { code, level: 'warn', get message() { return build(); }, file };
}

/** Summary: Ayar kaynaklarından biri yüzünden reddedilen yazma işlemi hatası (HTTP 409, data.code ile). */
class SettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettingsError';
    this.status = 409;
    this.data = { code };
  }
}

/** Summary: Marketplace ayarlarını dosya yerine var olan Claude Code dosyalarından ve sabitlerden türetir; ayar dosyası yazmaz. */
class MarketplaceSettings {
  constructor({ fsp, atomicWrite, Rules, FM }) {
    this.fsp = fsp;
    this.atomicWrite = atomicWrite;
    this.Rules = Rules;
    this.FM = FM;
    this.exportDefaults = Object.freeze({
      durumlar: Object.freeze(['kararlı', '']),
      haricKlasorler: Object.freeze([Rules.INBOX_DIR])
    });
  }

  /** Summary: Marketplace manifest dosyasının mutlak yolu. */
  manifestFile(dir) {
    return path.join(dir, '.claude-plugin', 'marketplace.json');
  }

  /** Summary: Eski ayar dosyasının mutlak yolu. */
  legacyFile(dir) {
    return path.join(dir, LEGACY_FILE);
  }

  /** Summary: Prompt klasöründeki bir plugin kaynak dosyasının (plugin.json) mutlak yolu. */
  pluginFile(dir, libraryDir, folder) {
    return path.join(dir, libraryDir, folder, '.claude-plugin', 'plugin.json');
  }

  /** Summary: Dosya sistemine dokunmadan varsayılan ayar nesnesini (taze dizi kopyalarıyla) üretir. */
  _defaults() {
    return {
      libraryDir: this.Rules.LIBRARY_DIR,
      libraryOk: true,
      marketplace: { name: '', owner: '', plugin: '', description: '', version: this.Rules.DEFAULT_VERSION },
      packages: {},
      export: {
        durumlar: this.exportDefaults.durumlar.slice(),
        haricKlasorler: this.exportDefaults.haricKlasorler.slice()
      }
    };
  }

  /** Summary: JSON dosyasını okur; { state: 'yok'|'ok'|'bozuk', json, why } döner (BOM atılır, kök nesne olmalı). */
  async _readJson(file) {
    let text;
    try { text = await this.fsp.readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { state: 'yok' };
      return { state: 'bozuk', why: readReason(e) };
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { state: 'bozuk', why: readReason(e) }; }
    if (!isPlain(parsed)) return { state: 'bozuk', why: { code: 'notObject', kind: typeKind(parsed) } };
    return { state: 'ok', json: parsed };
  }

  /** Summary: prompts/ altındaki plugin kaynak dosyalarından { slug: { description } } üretir (bozuk dosya atlanır, ilk gelen kazanır). */
  async _readPackages(dir, lib) {
    const out = {};
    let ents;
    try { ents = await this.fsp.readdir(lib, { withFileTypes: true }); } catch (e) { return out; }
    const names = ents.filter((e) => e.isDirectory() && e.name.charAt(0) !== '.').map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'tr'));
    for (const name of names) {
      const file = path.join(lib, name, '.claude-plugin', 'plugin.json');
      const st = await this.fsp.lstat(file).catch(() => null);
      if (!st || !st.isFile() || !paths.isInside(file, dir)) continue;
      const r = await this._readJson(file);
      if (r.state !== 'ok') continue;
      const description = typeof r.json.description === 'string' ? r.json.description.trim() : '';
      const slug = this.FM.slug(name);
      if (description && !Object.prototype.hasOwnProperty.call(out, slug)) out[slug] = { description };
    }
    return out;
  }

  /** Summary: Ayarı okur ve sağlığını değerlendirir; diske yazmaz. Dönüş: { cfg, manifestState: 'yok'|'ok'|'bozuk', issues }. */
  async inspect(dir) {
    const { Rules, FM } = this;
    const cfg = this._defaults();
    const issues = [];
    if (!dir) return { cfg, manifestState: 'yok', issues };

    const manifest = this.manifestFile(dir);
    let manifestState = 'yok';
    let mj = {};
    if (paths.isInside(manifest, dir)) {
      const r = await this._readJson(manifest);
      manifestState = r.state;
      if (r.state === 'ok') mj = r.json;
      if (r.state === 'bozuk') {
        const why = r.why;
        issues.push(lazyIssue('manifestBozuk', manifest, () => tx('cfg.manifestBozuk', { reason: reasonText(why) })));
      }
    }

    const meta = isPlain(mj.metadata) ? mj.metadata : {};
    const name = trimmedText(mj.name) || FM.slug(path.basename(dir));
    cfg.marketplace = {
      name,
      owner: isPlain(mj.owner) ? trimmedText(mj.owner.name) : '',
      plugin: FM.slug(name),
      description: trimmedText(mj.description) || trimmedText(meta.description),
      version: Rules.normalizeVersion(meta.version !== undefined ? meta.version : mj.version)
    };

    const lib = path.join(dir, Rules.LIBRARY_DIR);
    const st = await this.fsp.lstat(lib).catch(() => null);
    cfg.libraryOk = !(st && !paths.isInside(lib, dir));
    if (!cfg.libraryOk) {
      issues.push(lazyIssue('libraryDirGecersiz', lib, () => tx('cfg.promptsDisarida', { dir: Rules.LIBRARY_DIR })));
    } else if (st) {
      cfg.packages = await this._readPackages(dir, lib);
    }
    return { cfg, manifestState, issues };
  }

  /** Summary: Ayarı okur; dir boşsa dosya sistemine dokunmadan varsayılanları döner. */
  async load(dir) {
    return (await this.inspect(dir)).cfg;
  }

  /** Summary: Yazan işlemlerin ön koşulu; prompts/ dışarı çıkıyorsa (library) ya da marketplace.json bozuksa (manifest) SettingsError (409) fırlatır. */
  async loadStrict(dir, { library = true, manifest = false } = {}) {
    const r = await this.inspect(dir);
    const fail = (code) => { throw new SettingsError(code, r.issues.find((i) => i.code === code).message); };
    if (library && !r.cfg.libraryOk) fail('libraryDirGecersiz');
    if (manifest && r.manifestState === 'bozuk') fail('manifestBozuk');
    return r.cfg;
  }

  /** Summary: Plugin açıklamasını kaynak plugin.json dosyasına yazar, diğer anahtarları korur; klasör adı güvenli değilse ya da dosya marketplace dışına çıkıyorsa yazmaz ve false döner. */
  async setPluginDescription(dir, libraryDir, folder, description) {
    if (typeof folder !== 'string' || !folder || /[\\/]/.test(folder) || folder.charAt(0) === '.') return false;
    const file = this.pluginFile(dir, libraryDir, folder);
    if (!paths.isInside(file, dir)) return false;
    const r = await this._readJson(file);
    if (r.state === 'bozuk') {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      throw new SettingsError('pluginJsonBozuk', tx('cfg.pluginBozuk', { file: rel, reason: reasonText(r.why) }));
    }
    const current = r.state === 'ok' ? r.json : {};
    await this.fsp.mkdir(path.dirname(file), { recursive: true });
    await this.atomicWrite(file, JSON.stringify({ ...current, description }, null, 2) + '\n');
    return true;
  }

  /** Summary: Eski ayar dosyası düz bir dosya olarak var mı. */
  async hasLegacy(dir) {
    const st = await this.fsp.lstat(this.legacyFile(dir)).catch(() => null);
    return !!st && st.isFile();
  }
}

module.exports = { MarketplaceSettings, SettingsError, LEGACY_FILE };
