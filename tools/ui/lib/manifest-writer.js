'use strict';
/* plugin.json ve marketplace.json yazıcısı. Yazılan her dosya için UndoStack'e geri alma adımı eklenir.
 * Kataloğa yalnızca plugin.json dosyasında `version` olan (bir kez yayınlanmış) paketler girer;
 * marketplace.json girdilerine `version` yazılmaz (sürüm tek kaynaktan: plugin.json). */

const os = require('os');
const path = require('path');

function defaultOwner(cfg) {
  return cfg.marketplace.owner || (() => { try { return os.userInfo().username; } catch (e) { return 'ben'; } })();
}

class ManifestWriter {
  // root: () => etkin marketplace klasörü
  constructor({ root, fsp, atomicWrite, FM, Rules }) {
    this.root = root;
    this.fsp = fsp;
    this.atomicWrite = atomicWrite;
    this.FM = FM;
    this.Rules = Rules;
  }

  async readJson(abs) { try { return JSON.parse(await this.fsp.readFile(abs, 'utf8')); } catch (e) { return {}; } }

  pluginJsonPath(paket) { return path.join(this.root(), 'plugins', paket, '.claude-plugin', 'plugin.json'); }

  readPluginJson(paket) { return this.readJson(this.pluginJsonPath(paket)); }

  // Dosyayı özgün baytlarıyla geri yazacak (yoksa silecek) adımı ekler.
  async _protect(abs, undo) {
    let prev = null;
    try { prev = await this.fsp.readFile(abs); } catch (e) { /* yok */ }
    if (undo) {
      const created = [];
      if (prev === null) {
        const stop = this.root();
        for (let d = path.dirname(abs); d.length > stop.length; d = path.dirname(d)) {
          try { await this.fsp.access(d); break; } catch (e) { created.push(d); }
        }
        undo.push(async () => { for (const d of created) { try { await this.fsp.rmdir(d); } catch (e) { /* dolu */ } } });
      }
      undo.push(async () => {
        if (prev === null) await this.fsp.rm(abs, { force: true });
        else await this.fsp.writeFile(abs, prev);
      });
    }
  }

  async _write(abs, obj, undo) {
    await this._protect(abs, undo);
    await this.atomicWrite(abs, JSON.stringify(obj, null, 2) + '\n', { mkdir: true });
  }

  /* opts: { version: string|null (null: mevcut sürümü koru), description } */
  async writePluginJson(paket, cfg, opts, undo) {
    const cur = await this.readPluginJson(paket);
    const pk = cfg.packages || {};
    const pm = pk[paket] || {};
    const next = { ...cur, name: paket };
    next.description = String(pm.description || '').trim() || cur.description || (opts && opts.description) || `${paket}: ${cfg.marketplace.description}`;
    next.author = cur.author || { name: defaultOwner(cfg) };
    if (opts && opts.version) next.version = opts.version;
    await this._write(this.pluginJsonPath(paket), next, undo);
    return next;
  }

  // plugins/ altında plugin.json'ında geçerli `version` olan paketler: { name, description }
  async listed() {
    const out = [];
    let ents = [];
    try { ents = await this.fsp.readdir(path.join(this.root(), 'plugins'), { withFileTypes: true }); } catch (e) { return out; }
    for (const d of ents) {
      if (!d.isDirectory() || d.name.charAt(0) === '.') continue;
      const pj = await this.readPluginJson(d.name);
      if (pj.version && !this.Rules.checkVersion(pj.version)) out.push({ name: d.name, description: pj.description || '' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }

  /* marketplace.json: üst alanlar, katalog sürümü ve kendi girdilerimiz. Harici girdiler korunur.
   * opts.version verilirse katalog sürümü olarak yazılır. Dönüş: listelenen paket adları. */
  async writeMarketplace(cfg, opts, undo) {
    const file = path.join(this.root(), '.claude-plugin', 'marketplace.json');
    const cur = await this.readJson(file);
    const mk = cfg.marketplace;
    const next = {
      ...cur,
      name: this.FM.slug(mk.name),
      description: mk.description,
      owner: { ...(cur.owner || {}), name: defaultOwner(cfg) }
    };
    const version = opts && opts.version;
    if (version) {
      if (cur.metadata && typeof cur.metadata === 'object' && cur.metadata.version !== undefined) next.metadata = { ...cur.metadata, version };
      else next.version = version;
    }
    const prev = new Map((cur.plugins || []).map((p) => [p.name, p]));
    const listed = await this.listed();
    const own = listed.map((l) => {
      const { version: _v, ...rest } = prev.get(l.name) || {};
      return { ...rest, name: l.name, source: './plugins/' + l.name, description: l.description || `${l.name}: ${mk.description}` };
    });
    const external = (cur.plugins || []).filter((p) => !(typeof p.source === 'string' && p.source.startsWith('./plugins/')));
    next.plugins = own.concat(external);
    await this._write(file, next, undo);
    return listed.map((l) => l.name);
  }

  async ensureReadme(cfg, undo) {
    const readme = path.join(this.root(), 'plugins', 'README.md');
    try { await this.fsp.access(readme); return; } catch (e) { /* yok */ }
    await this._protect(readme, undo);
    await this.atomicWrite(readme, `# plugins\n\nBu klasördeki komut, ajan ve skill dosyaları \`${cfg.libraryDir}/\` içindeki promptlardan otomatik üretilir.\nDüzenlemeyi kaynakta yap, sonra arayüzden yayınla. Burada yapılan değişiklikler bir sonraki yayında ezilir.\n`, { mkdir: true });
  }
}

module.exports = { ManifestWriter, defaultOwner };
