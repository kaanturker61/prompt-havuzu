'use strict';
/* Git işlemlerinin tek kapısı. Her çağrı `git -C <dir> -c core.quotepath=false ...` biçimindedir;
 * shell yoktur, cwd kullanılmaz. Araç reposu (forbiddenRoots) içinde komut çalıştırılmaz. */

const { execFile } = require('child_process');
const path = require('path');
const { samePath, isInside } = require('./paths');

const HASH_RE = /^[0-9a-f]{7,40}$/;
const REF_RE = /^[a-z0-9][a-z0-9/._-]*$/;
const IDENTITY_RE = /Author identity unknown|tell me who you are|empty ident/i;

class GitError extends Error {
  constructor(message, { stderr = '', exitCode = null, args = [] } = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.args = args;
  }

  get isIdentityError() { return IDENTITY_RE.test(this.message) || IDENTITY_RE.test(this.stderr); }
}

class GitNotFoundError extends GitError {
  constructor(args) {
    super('git bulunamadı. Git kurulu ve PATH içinde olmalı.', { args });
    this.name = 'GitNotFoundError';
  }
}

function statusCode(x, y) {
  if (x === '?') return '?';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'A') return 'A';
  if (x === 'R' || x === 'C') return 'R';
  return 'M';
}

// `status --porcelain=v1 -z` çıktısını ayrıştırır (saf fonksiyon).
function parseStatus(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const x = p[0]; const y = p[1];
    if (x === 'R' || x === 'C') i++; // sonraki parça eski ad
    files.push({ x, y, path: p.slice(3), code: statusCode(x, y) });
  }
  return files;
}

// `log` çıktısını ayrıştırır (saf fonksiyon).
function parseLogOutput(out) {
  const commits = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).split('\x1f');
    const names = nl < 0 ? [] : chunk.slice(nl + 1).split('\n').map((s) => s.trim()).filter(Boolean);
    commits.push({ hash: head[0], short: head[1], author: head[2], date: head[3], subject: head[4], path: names[0] || null });
  }
  return commits;
}

class GitService {
  constructor({ bin = 'git', runner = execFile, env = {}, forbiddenRoots = [] } = {}) {
    this.bin = bin;
    this.runner = runner;
    this.env = env;
    this.forbiddenRoots = forbiddenRoots;
  }

  _exec(args) {
    return new Promise((resolve, reject) => {
      this.runner(this.bin, args, {
        maxBuffer: 50 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...this.env }
      }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.code === 'ENOENT') return reject(new GitNotFoundError(args));
        reject(new GitError((stderr || err.message || '').trim(), {
          stderr: stderr || '', exitCode: typeof err.code === 'number' ? err.code : null, args
        }));
      });
    });
  }

  // Düşük seviye: yalnızca bu sınıf ve testler kullanır.
  run(dir, args) {
    const abs = path.resolve(String(dir));
    for (const f of this.forbiddenRoots) {
      if (samePath(abs, f) || isInside(abs, f)) {
        return Promise.reject(new GitError('Araç reposunda git işlemi yapılamaz', { args }));
      }
    }
    return this._exec(['-C', abs, '-c', 'core.quotepath=false', ...args]);
  }

  version() { return this._exec(['--version']); }

  // { path: mutlak yol|null, error: string|null }
  async toplevelInfo(dir) {
    try {
      const out = (await this.run(dir, ['rev-parse', '--show-toplevel'])).trim();
      return out ? { path: path.resolve(out), error: null } : { path: null, error: 'Boş yanıt' };
    } catch (e) {
      if (e instanceof GitNotFoundError) throw e;
      if (e.message === 'Araç reposunda git işlemi yapılamaz') throw e;
      return { path: null, error: e.message };
    }
  }

  async toplevel(dir) { return (await this.toplevelInfo(dir)).path; }

  async isRepoRoot(dir) {
    const top = await this.toplevel(dir);
    return !!top && samePath(top, dir);
  }

  async init(dir, { branch = 'main' } = {}) {
    await this.run(dir, ['init']);
    try { await this.run(dir, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]); } catch (e) { /* eski git */ }
  }

  async hasCommits(dir) {
    try { await this.run(dir, ['rev-parse', '--verify', 'HEAD']); return true; } catch (e) { return false; }
  }

  async getConfig(dir, key) {
    try { return (await this.run(dir, ['config', key])).trim(); } catch (e) { return ''; }
  }

  async setConfig(dir, key, value) { await this.run(dir, ['config', key, value]); }

  async status(dir) {
    let branch = 'main';
    try { branch = (await this.run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch (e) { /* ayrık HEAD */ }
    const out = await this.run(dir, ['status', '--porcelain=v1', '-z', '-uall']);
    return {
      isRepo: true, branch, files: parseStatus(out), hasCommits: await this.hasCommits(dir),
      identity: { name: await this.getConfig(dir, 'user.name'), email: await this.getConfig(dir, 'user.email') }
    };
  }

  // Döner: kısa commit hash'i. Kimlik eksikse GitError.isIdentityError true olur.
  async commitPaths(dir, message, paths) {
    await this.run(dir, ['add', '-A', '--', ...paths]);
    await this.run(dir, ['commit', '-m', message, '--', ...paths]);
    return (await this.run(dir, ['rev-parse', '--short', 'HEAD'])).trim();
  }

  async log(dir, { path: rel, limit = 60, follow = false, range } = {}) {
    if (range) { const [a, b] = String(range).split('..'); this._checkHash(a); if (b !== 'HEAD') this._checkHash(b); }
    const fmt = '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s';
    const args = ['log', ...(follow ? ['--follow'] : []), ...(rel ? ['--name-only'] : []), '-n', String(limit), fmt, ...(range ? [range] : []), ...(rel ? ['--', rel] : [])];
    let out;
    try { out = await this.run(dir, args); } catch (e) {
      if (/does not have any commits|bad default revision|unknown revision/i.test(e.message)) return [];
      throw e;
    }
    return parseLogOutput(out);
  }

  _checkHash(hash) {
    if (!HASH_RE.test(String(hash))) throw new GitError('Geçersiz commit');
  }

  _checkRef(name, { prefix = false } = {}) {
    const n = String(name);
    if (!REF_RE.test(n) || n.includes('..') || (!prefix && n.endsWith('/')) || n.endsWith('.lock')) throw new GitError('Geçersiz tag adı');
  }

  // HEAD'in tam hash'i; doğmamış dalda null.
  async headCommit(dir) {
    try { return (await this.run(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null; } catch (e) {
      if (e instanceof GitNotFoundError || e.message === 'Araç reposunda git işlemi yapılamaz') throw e;
      return null;
    }
  }

  async createTag(dir, name, message, commit) {
    this._checkRef(name); this._checkHash(commit);
    await this.run(dir, ['tag', '-a', '--cleanup=whitespace', '-m', message, name, commit]);
  }

  async deleteTag(dir, name) {
    this._checkRef(name);
    await this.run(dir, ['tag', '-d', name]);
  }

  // [{ name, object, commit, date }]. prefix 'prompt/' gibi, '/' ile biten bir ad alanıdır.
  async listTags(dir, prefix = '') {
    if (prefix) this._checkRef(prefix, { prefix: true });
    const fmt = '--format=%(refname:strip=2)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)';
    const out = await this.run(dir, ['for-each-ref', fmt, 'refs/tags/' + prefix]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [name, object, peeled, date] = line.split('\x1f');
      return { name, object, commit: peeled || object, date };
    });
  }

  // commit'i CAS ile geri alır: HEAD artık o commit değilse hata verir.
  async undoCommit(dir, { commit, parent } = {}) {
    this._checkHash(commit);
    if (parent) {
      this._checkHash(parent);
      await this.run(dir, ['update-ref', '-m', 'prompt-havuzu: sürüm geri alındı', 'HEAD', parent, commit]);
      return;
    }
    const ref = (await this.run(dir, ['symbolic-ref', '-q', 'HEAD'])).trim();
    if (!ref) throw new GitError('HEAD bir dala bağlı değil, ilk commit geri alınamadı');
    await this.run(dir, ['update-ref', '-d', ref, commit]);
  }

  // Yolları index'ten çıkarır (çalışma ağacına dokunmaz).
  async unstage(dir, paths) {
    if (!paths || !paths.length) return;
    if (await this.hasCommits(dir)) await this.run(dir, ['reset', '-q', '--', ...paths]);
    else await this.run(dir, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...paths]);
  }

  // rev:rel blob'unun sha'sı; yoksa null.
  async blobAt(dir, rev, rel) {
    this._checkHash(rev);
    try { return (await this.run(dir, ['rev-parse', '--verify', '-q', rev + ':' + rel])).trim() || null; } catch (e) {
      if (e instanceof GitNotFoundError || e.message === 'Araç reposunda git işlemi yapılamaz') throw e;
      return null;
    }
  }

  // Çalışma ağacındaki dosyaların blob sha'ları (eol/gitattributes uygulanır); sırayla döner.
  async hashFiles(dir, rels) {
    if (!rels || !rels.length) return [];
    return (await this.run(dir, ['hash-object', '--', ...rels])).split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async showFile(dir, hash, rel) {
    this._checkHash(hash);
    return this.run(dir, ['show', hash + ':' + rel]);
  }

  async showCommit(dir, hash, { path: rel, stat = false } = {}) {
    this._checkHash(hash);
    if (rel) return this.run(dir, ['show', '--no-color', '--format=', hash, '--', rel]);
    if (stat) return this.run(dir, ['show', '--no-color', '--stat', '-p', '--format=%s%n%an, %aI%n', hash]);
    return this.run(dir, ['show', '--no-color', '--format=', hash]);
  }

  async diffWorking(dir, rel) {
    let tracked = true;
    try { await this.run(dir, ['ls-files', '--error-unmatch', '--', rel]); } catch (e) { tracked = false; }
    if (!tracked) return { diff: '', untracked: true };
    let diff = '';
    try { diff = await this.run(dir, ['diff', '--no-color', 'HEAD', '--', rel]); } catch (e) { /* henüz commit yok */ }
    return { diff };
  }
}

module.exports = { GitService, GitError, GitNotFoundError, parseStatus, parseLogOutput, HASH_RE };
