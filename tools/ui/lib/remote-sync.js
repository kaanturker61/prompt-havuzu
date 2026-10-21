'use strict';
/* Uzak depo: durum, kontrol (fetch), push ve yalnızca ileri sarma (pull). Otomatik birleştirme/rebase yoktur.
 * Git komutu bilmez; yalnızca GitService metotlarını çağırır. Ağ işlemleri 'ag', HEAD'i değiştirenler 'yaz' kilidi altındadır. */

const { GitError } = require('./git-service');
const { UndoStack } = require('./undo');
const { describeNetError } = require('./net-errors');
const { BusyError } = require('./op-lock');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

/** Summary: Kirli dosya listesini en çok 5 öğeyle birleştirir, fazlası için sonuna ' …' ekler. */
function dirtyList(files) {
  return files.slice(0, 5).join(', ') + (files.length > 5 ? ' …' : '');
}

const HOUR = 60 * 60 * 1000;

class RemoteError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
    if (data) this.data = data;
  }
}

class RemoteSync {
  // onChanged(dir): HEAD ya da tag'ler değişince çağrılır (önbellekleri temizlemek için).
  constructor({ git, state, lock, Rules, onChanged = () => {}, now = () => Date.now() }) {
    this.git = git;
    this.state = state;
    this.lock = lock;
    this.Rules = Rules;
    this.onChanged = onChanged;
    this.now = now;
  }

  async _remote(dir, name) {
    const list = await this.git.remotes(dir);
    if (!list.length) throw new RemoteError(409, tx('remote.err.remoteYok'), { code: 'remoteYok' });
    if (name) {
      const hit = list.find((r) => r.name === name);
      if (!hit) throw new RemoteError(404, tx('remote.err.bulunamadi', { name }));
      return hit;
    }
    return list.find((r) => r.name === 'origin') || list[0];
  }

  _netFail(e, remote, dir) {
    const code = (e && e.netCode) || 'bilinmiyor';
    return { ok: false, code, error: describeNetError(code, { url: remote && remote.url, dir }), detail: String((e && (e.stderr || e.message)) || '').trim().slice(0, 600) };
  }

  /** Summary: Diskteki lastCheck kaydını API şekline çevirir; error metni okuma anındaki dilde koddan üretilir (diske yazılmaz). */
  async _presentLastCheck(dir, last, remotes) {
    if (!last) return null;
    if (last.ok !== false) return { ...last, error: null };
    const code = typeof last.code === 'string' && last.code ? last.code : 'bilinmiyor';
    let url;
    if (code === 'kimlik') {
      const list = remotes || await this.git.remotes(dir).catch(() => []);
      const hit = list.find((r) => r.name === 'origin') || list[0];
      url = hit && hit.url;
    }
    return { ...last, error: describeNetError(code, { url, dir }) };
  }

  async list(dir) {
    const { Rules } = this;
    return (await this.git.remotes(dir)).map((r) => {
      const provider = Rules.repoProvider(r.url);
      return { name: r.name, url: r.url, provider, addCommand: Rules.marketplaceAddCommand(r.url).primary };
    });
  }

  async addRemote(dir, name, url) {
    const { Rules } = this;
    const ne = Rules.checkRemoteName(name);
    if (ne) throw new RemoteError(400, ne, { code: 'remoteAdGecersiz' });
    const n = Rules.normalizeRepoUrl(url);
    if (n.error) throw new RemoteError(400, n.error, { code: 'urlGecersiz' });
    return this.lock.run(dir, 'yaz', async () => {
      if ((await this.git.remotes(dir)).some((r) => r.name === name)) throw new RemoteError(409, tx('remote.err.adVar', { name }));
      await this.git.addRemote(dir, name, n.url);
      return { name, url: n.url, provider: n.provider };
    });
  }

  async setRemote(dir, name, url) {
    const { Rules } = this;
    const n = Rules.normalizeRepoUrl(url);
    if (n.error) throw new RemoteError(400, n.error, { code: 'urlGecersiz' });
    return this.lock.run(dir, 'yaz', async () => {
      if (!(await this.git.remotes(dir)).some((r) => r.name === name)) throw new RemoteError(404, tx('remote.err.bulunamadi', { name }));
      await this.git.setRemoteUrl(dir, name, n.url);
      return { name, url: n.url, provider: n.provider };
    });
  }

  // Karşılaştırma referansı: önce upstream, yoksa refs/remotes/<remote>/<dal>.
  async _trackingRef(dir, remote) {
    const branch = await this.git.currentBranch(dir);
    if (!branch) return { branch: null, ref: null };
    return { branch, ref: 'refs/remotes/' + remote + '/' + branch };
  }

  async status(dir) {
    const remotes = await this.list(dir);
    const st = await this.state.get(dir);
    const branch = await this.git.currentBranch(dir);
    const upstream = await this.git.upstream(dir);
    let ahead = 0; let behind = 0;
    if (remotes.length && branch) {
      const r = remotes.find((x) => x.name === 'origin') || remotes[0];
      const ab = await this.git.aheadBehind(dir, upstream ? 'refs/remotes/' + upstream : 'refs/remotes/' + r.name + '/' + branch);
      ahead = ab.ahead; behind = ab.behind;
    }
    return { remotes, branch, upstream, ahead, behind, pendingTags: st.pendingTags, lastCheck: await this._presentLastCheck(dir, st.lastCheck, remotes), folder: dir };
  }

  async _compute(dir, remoteName) {
    const { git } = this;
    const { branch, ref } = await this._trackingRef(dir, remoteName);
    let ab = { ahead: 0, behind: 0 }; let newCommits = [];
    if (branch) {
      ab = await git.aheadBehind(dir, ref);
      newCommits = (await git.logRange(dir, 'HEAD', ref, 20)).map((c) => ({ short: c.short, subject: c.subject, date: c.date }));
    }
    const prefix = 'refs/pp/uzak/' + remoteName + '/';
    const remoteTags = await git.listRefs(dir, prefix);
    const local = new Map((await git.listTags(dir, '')).map((t) => [t.name, t.object]));
    const newTags = remoteTags.map((r) => r.name.slice(prefix.length)).filter((n) => !local.has(n));
    // Uzakta aynı nesneyle görülen bekleyen tag'ler artık bekleyen değildir.
    const st = await this.state.get(dir);
    const done = st.pendingTags.filter((t) => { const r = remoteTags.find((x) => x.name === prefix + t); return r && local.get(t) === r.object; });
    if (done.length) await this.state.removePending(dir, done);
    return { behind: ab.behind, ahead: ab.ahead, newCommits, newTags, remoteTags };
  }

  /* Salt okuma. opts: { remote, background, setting: 'acilista'|'elle' }. Hatalar { ok: false, code, error } olarak döner. */
  async fetch(dir, opts = {}) {
    const bg = !!opts.background;
    const last = (await this.state.get(dir)).lastCheck;
    if (bg) {
      if (opts.setting === 'elle') return { ok: true, skipped: 'elle', cached: true, ...((await this._presentLastCheck(dir, last)) || {}) };
      if (last && last.at && last.ok && this.now() - Date.parse(last.at) < HOUR) return { ...(await this._presentLastCheck(dir, last)), cached: true };
    }
    let remote;
    try { remote = await this._remote(dir, opts.remote); } catch (e) {
      if (bg && e instanceof RemoteError) return { ok: false, code: 'remoteYok', error: e.message };
      throw e;
    }
    const checkedAt = new Date(this.now()).toISOString();
    try {
      return await this.lock.run(dir, 'ag', async () => {
        try {
          await this.git.fetch(dir, remote.name, { interactive: !bg });
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          const f = this._netFail(e, remote, dir);
          const res = { ...f, checkedAt, at: checkedAt };
          await this.state.setLastCheck(dir, { at: checkedAt, ok: false, code: f.code, behind: 0, newTags: [], newCommits: [] });
          return res;
        }
        const c = await this._compute(dir, remote.name);
        const res = { ok: true, behind: c.behind, ahead: c.ahead, newCommits: c.newCommits, newTags: c.newTags, checkedAt };
        await this.state.setLastCheck(dir, { at: checkedAt, ok: true, behind: c.behind, ahead: c.ahead, newTags: c.newTags, newCommits: c.newCommits });
        return res;
      });
    } catch (e) {
      if (e instanceof BusyError && bg) return { ok: false, code: 'mesgul', error: describeNetError('mesgul') };
      throw e;
    }
  }

  /* Dalı ve bekleyen paket tag'lerini gönderir. Kilit çağıranda değil burada alınır (ag).
   * Dönüş: { ok: true } | { ok: false, code, error, detail }. Kilit doluysa mesgul. */
  async push(dir, opts = {}) {
    const remote = await this._remote(dir, opts.remote);
    const branch = await this.git.currentBranch(dir);
    if (!branch) throw new RemoteError(409, tx('remote.err.dalYokPush'), { code: 'dalYok' });
    try {
      return await this.lock.run(dir, 'ag', async () => {
        const st = await this.state.get(dir);
        const local = new Set((await this.git.listTags(dir, '')).map((t) => t.name));
        const tags = st.pendingTags.filter((t) => local.has(t));
        const upstream = await this.git.upstream(dir);
        try {
          await this.git.push(dir, { remote: remote.name, branch, tags, setUpstream: !upstream, interactive: true });
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          return this._netFail(e, remote, dir);
        }
        await this.state.removePending(dir, st.pendingTags);
        return { ok: true };
      });
    } catch (e) {
      if (e instanceof BusyError) return { ok: false, code: 'mesgul', error: describeNetError('mesgul') };
      throw e;
    }
  }

  /* Yalnızca ileri sarma. Dönüş: { ok, from, to, adoptedTags }. */
  async pull(dir, opts = {}) {
    const { git, Rules } = this;
    const remote = await this._remote(dir, opts.remote);
    const f = await this.fetch(dir, { remote: remote.name, background: false });
    if (!f.ok) throw new RemoteError(502, f.error, { code: f.code });
    return this.lock.run(dir, 'yaz', async () => {
      const dirty = await git.isClean(dir, []);
      if (dirty.length) {
        throw new RemoteError(409, tx('remote.err.kirli', { files: dirtyList(dirty) }), { code: 'kirliCalismaAgaci', files: dirty });
      }
      const { branch, ref } = await this._trackingRef(dir, remote.name);
      if (!branch) throw new RemoteError(409, tx('remote.err.dalYok'), { code: 'dalYok' });
      const from = await git.headCommit(dir);
      if (!from) throw new RemoteError(409, tx('remote.err.commitYok'), { code: 'commitYok' });
      if (!(await git.refExists(dir, ref))) throw new RemoteError(409, tx('remote.err.uzakDalYok', { branch }), { code: 'uzakDalYok' });
      const ab = await git.aheadBehind(dir, ref);
      if (ab.ahead > 0 && ab.behind > 0) {
        throw new RemoteError(409, tx('remote.err.ayristi', { dir }), { code: 'ayristi' });
      }
      if (ab.behind === 0) throw new RemoteError(409, tx('remote.err.guncel'), { code: 'guncel' });
      const undo = new UndoStack();
      try {
        await git.mergeFfOnly(dir, ref);
        const to = await git.headCommit(dir);
        undo.push(() => git.resetKeep(dir, { expect: to, to: from }));
        const prefix = 'refs/pp/uzak/' + remote.name + '/';
        const local = new Set((await git.listTags(dir, '')).map((t) => t.name));
        const adopted = [];
        for (const r of await git.listRefs(dir, prefix)) {
          const name = r.name.slice(prefix.length);
          if (local.has(name)) continue;
          if (!Rules.parsePackageTag(name) && !Rules.parsePromptTag(name)) continue;
          if (!(await git.isAncestor(dir, r.commit, to))) continue;
          await git.createTagAt(dir, name, r.object);
          undo.push(() => git.deleteTag(dir, name));
          adopted.push(name);
        }
        undo.clear();
        await this.state.setLastCheck(dir, { at: new Date(this.now()).toISOString(), ok: true, behind: 0, ahead: 0, newTags: [], newCommits: [] });
        this.onChanged(dir);
        return { ok: true, from, to, adoptedTags: adopted };
      } catch (e) {
        try { await undo.rollback(); } catch (agg) {
          throw new RemoteError(500, tx('remote.err.rollbackFailed', { detail: (agg.errors || [agg]).map((x) => x.message).join('; ') }), { code: 'rollbackFailed', rollbackFailed: true });
        }
        throw new RemoteError(500, tx('remote.err.failed', { error: e.message }), { code: 'geriAlindi' });
      }
    });
  }
}

module.exports = { RemoteSync, RemoteError, HOUR };
