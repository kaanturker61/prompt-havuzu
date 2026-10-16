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
  /** Summary: code, ileti metninden bağımsız hata türüdür (örn. 'aracReposu'); yoksa null. */
  constructor(message, { stderr = '', exitCode = null, args = [], code = null } = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.args = args;
    this.code = code;
  }

  get isIdentityError() { return IDENTITY_RE.test(this.message) || IDENTITY_RE.test(this.stderr); }
}

// Ağ işlemlerinin (push, fetch, clone) stderr çıktısını sınıflandırır (saf fonksiyon).
// Dönüş: kimlik | ag | bulunamadi | reddedildi | atomikYok | zamanAsimi | bilinmiyor
const NET_PATTERNS = [
  ['atomikYok', /does not support --atomic|atomic push failed|atomic push is not supported/i],
  ['reddedildi', /\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]|Updates were rejected|tip of your current branch is behind/i],
  ['kimlik', /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey\)|HTTP Basic: Access denied|\b403\b|Host key verification failed|interaction is required/i],
  ['bulunamadi', /Repository not found|not found|does not appear to be a git repository|does not exist/i],
  ['ag', /Could not resolve host|unable to access|Connection (timed out|refused|reset)|Network is unreachable|Failed to connect/i]
];

function classifyGitNetError(stderr, err) {
  if (err && err.timedOut) return 'zamanAsimi';
  const text = String(stderr || (err && (err.stderr || err.message)) || '');
  for (const [code, re] of NET_PATTERNS) if (re.test(text)) return code;
  return 'bilinmiyor';
}

// Yerel işlemlerin (commit, add ...) stderr çıktısını sınıflandırır (saf fonksiyon). Kimlik hatası ayrı yürür (GitError.isIdentityError).
// Dönüş: kilit | eklenemedi | commitReddedildi | bilinmiyor
const GIT_PATTERNS = [
  ['kilit', /Unable to create '[^\r\n]*\.lock': File exists|Another git process seems to be running/i],
  ['eklenemedi', /adding files failed|unable to index file|open\("[^"\r\n]*"\): No such file or directory/i]
];

// `-C <dir>` ve `-c <ayar>` çiftlerini atlayıp git alt komutunu (commit, add ...) bulur.
function gitSubcommand(args) {
  const a = Array.isArray(args) ? args : [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-C' || a[i] === '-c') { i++; continue; }
    if (!String(a[i]).startsWith('-')) return String(a[i]);
  }
  return '';
}

function classifyGitError(stderr, err) {
  const text = String(stderr || (err && (err.stderr || err.message)) || '');
  for (const [code, re] of GIT_PATTERNS) if (re.test(text)) return code;
  // Başka kalıp yoksa başarısız olan commit'tir (commit hook'u reddi dahil; hook çıktısı stderr'dedir).
  if (err && gitSubcommand(err.args) === 'commit') return 'commitReddedildi';
  return 'bilinmiyor';
}

const ZERO_OID = '0'.repeat(40);
const ANY_REF_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;
const REMOTE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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

// `for-each-ref` çıktısını ayrıştırır (saf fonksiyon). Kayıt ayırıcı \x1e, alan ayırıcı \x1f.
// İlk dört alan (name, object, commit, date) eskisiyle aynıdır; yenileri sona eklenir.
function parseTagRefs(out) {
  const tags = [];
  for (const rec of String(out).split('\x1e')) {
    const r = rec.replace(/\r/g, '').replace(/^\n+/, '');
    if (!r.trim()) continue;
    const [name, object, peeled, date, type, tagger, subject, body] = r.split('\x1f');
    const annotated = type === 'tag';
    tags.push({
      name, object, commit: peeled || object, date,
      annotated, tagger: annotated ? (tagger || '') : '',
      subject: annotated ? (subject || '') : '', body: annotated ? (body || '').replace(/\n+$/, '') : ''
    });
  }
  return tags;
}

// `log --name-status` çıktısını ayrıştırır (saf fonksiyon). Tırnaklı (sekmeli/özel karakterli) yollar atlanır.
function parseChangeLog(out) {
  const commits = [];
  for (const chunk of String(out).split('\x1e')) {
    if (!chunk.trim()) continue;
    const lines = chunk.replace(/\r/g, '').split('\n');
    const head = lines[0].split('\x1f');
    const files = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = (parts[0] || '')[0];
      if (!/[AMDRCT]/.test(status || '')) continue;
      const paths = parts.slice(1);
      if (paths.some((x) => x.startsWith('"'))) continue;
      if ((status === 'R' || status === 'C') && paths.length >= 2) files.push({ status, path: paths[1], oldPath: paths[0] });
      else if (paths.length >= 1) files.push({ status, path: paths[0] });
    }
    commits.push({ hash: head[0], short: head[1], author: head[2], date: head[3], subject: head[4], files });
  }
  return commits;
}

// `diff --word-diff=porcelain` çıktısını ayrıştırır (saf fonksiyon).
function parseWordDiff(out) {
  const hunks = [];
  let h = null; let line = [];
  for (const raw of String(out).split('\n')) {
    const l = raw.replace(/\r$/, '');
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      if (h && line.length) { h.lines.push(line); line = []; }
      h = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(h); line = [];
      continue;
    }
    if (!h) continue;
    if (l.startsWith('\\')) continue; // \ No newline at end of file
    if (l === '~') { h.lines.push(line); line = []; continue; }
    const c = l[0];
    if (c === ' ') line.push({ t: '=', s: l.slice(1) });
    else if (c === '-') line.push({ t: '-', s: l.slice(1) });
    else if (c === '+') line.push({ t: '+', s: l.slice(1) });
  }
  if (h && line.length) h.lines.push(line);
  return { hunks };
}

class GitService {
  constructor({ bin = 'git', runner = execFile, env = {}, forbiddenRoots = [] } = {}) {
    this.bin = bin;
    this.runner = runner;
    this.env = env;
    this.forbiddenRoots = forbiddenRoots;
  }

  // opts: { timeout (ms), env }. Zaman aşımında GitError.timedOut true olur.
  _exec(args, opts = {}) {
    return new Promise((resolve, reject) => {
      let done = false; let timer = null;
      const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(v); };
      const ro = {
        maxBuffer: 50 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...this.env, ...(opts.env || {}) }
      };
      if (opts.timeout) {
        ro.timeout = opts.timeout;
        // Çocuk süreçler (kimlik penceresi) boruyu açık tutarsa geri çağrı hiç gelmeyebilir.
        timer = setTimeout(() => {
          const e = new GitError('İşlem zaman aşımına uğradı', { args });
          e.timedOut = true;
          finish(reject, e);
        }, opts.timeout + 2000);
        if (timer.unref) timer.unref();
      }
      this.runner(this.bin, args, ro, (err, stdout, stderr) => {
        if (!err) return finish(resolve, stdout);
        if (err.code === 'ENOENT') return finish(reject, new GitNotFoundError(args));
        const ge = new GitError((stderr || err.message || '').trim(), {
          stderr: stderr || '', exitCode: typeof err.code === 'number' ? err.code : null, args
        });
        if (opts.timeout && (err.killed || err.signal)) ge.timedOut = true;
        finish(reject, ge);
      });
    });
  }

  // Düşük seviye: yalnızca bu sınıf ve testler kullanır.
  run(dir, args, opts) {
    const abs = path.resolve(String(dir));
    for (const f of this.forbiddenRoots) {
      if (samePath(abs, f) || isInside(abs, f)) {
        return Promise.reject(new GitError('Araç reposunda git işlemi yapılamaz', { args, code: 'aracReposu' }));
      }
    }
    return this._exec(['-C', abs, '-c', 'core.quotepath=false', ...args], opts);
  }

  // Ağ komutlarının önüne konan güvenlik ayarları. Dış taşımalar kapalı; SSH parola sormaz.
  async _netArgs(dir) {
    const out = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never'];
    const e = { ...process.env, ...this.env };
    if (!e.GIT_SSH && !e.GIT_SSH_COMMAND && dir && !(await this.getConfig(dir, 'core.sshCommand'))) {
      out.push('-c', 'core.sshCommand=ssh -o BatchMode=yes');
    }
    return out;
  }

  // Ağ işlemi: sınıflandırılmış hata (netCode) ile fırlatır.
  async _net(dir, args, { interactive = false, timeout = 120000 } = {}) {
    const net = await this._netArgs(dir);
    const env = interactive ? {} : { GCM_INTERACTIVE: 'never' };
    try {
      return await this.run(dir, [...net, ...args], { timeout, env });
    } catch (e) {
      if (e instanceof GitError && !(e instanceof GitNotFoundError) && e.code !== 'aracReposu') {
        e.netCode = classifyGitNetError(e.stderr || e.message, e);
      }
      throw e;
    }
  }

  version() { return this._exec(['--version']); }

  // { path: mutlak yol|null, error: string|null }
  async toplevelInfo(dir) {
    try {
      const out = (await this.run(dir, ['rev-parse', '--show-toplevel'])).trim();
      return out ? { path: path.resolve(out), error: null } : { path: null, error: 'Boş yanıt' };
    } catch (e) {
      if (e instanceof GitNotFoundError) throw e;
      if (e.code === 'aracReposu') throw e;
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

  // Ayrık HEAD'de branch null, detached true, head kısa hash'tir. Doğmamış dalda (commit yok) symbolic-ref başarılı olur ve dal adı (main) döner.
  async status(dir) {
    let branch = 'main'; let detached = false; let head = null;
    try { branch = (await this.run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch (e) {
      // symbolic-ref başarısız ama HEAD bir commit'e çözülüyorsa HEAD ayrıktır. Çözülmüyorsa (depo bozuk) status komutu gerçek hatayı verir.
      const short = await this.run(dir, ['rev-parse', '--short', 'HEAD']).then((s) => s.trim(), () => '');
      if (short) { branch = null; detached = true; head = short; }
    }
    const out = await this.run(dir, ['status', '--porcelain=v1', '-z', '-uall']);
    return {
      isRepo: true, branch, detached, head, files: parseStatus(out), hasCommits: await this.hasCommits(dir),
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
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
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

  // [{ name, object, commit, date, annotated, tagger, subject, body }]. prefix 'prompt/' gibi, '/' ile biten bir ad alanıdır.
  async listTags(dir, prefix = '') {
    if (prefix) this._checkRef(prefix, { prefix: true });
    const fmt = '--format=%(refname:strip=2)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)%1f%(objecttype)%1f%(taggername)%1f%(contents:subject)%1f%(contents:body)%1e';
    const out = await this.run(dir, ['for-each-ref', fmt, 'refs/tags/' + prefix]);
    return parseTagRefs(out);
  }

  // Salt okunur: name-status'lu log (rename dahil). from/to verilirse `from..to` aralığı.
  async changeLog(dir, { path: rel, follow = false, limit = 300, from, to } = {}) {
    if (from !== undefined || to !== undefined) { this._checkHash(from); this._checkHash(to); }
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new GitError('Geçersiz limit');
    const fmt = '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s';
    const args = ['log', ...(follow ? ['--follow'] : []), '-M', '--name-status', '-n', String(n), fmt,
      ...(from ? [from + '..' + to] : []), ...(rel ? ['--', rel] : [])];
    let out;
    try { out = await this.run(dir, args); } catch (e) {
      if (/does not have any commits|bad default revision|unknown revision/i.test(e.message)) return [];
      throw e;
    }
    return parseChangeLog(out);
  }

  // Salt okunur: iki blob arasında kelime bazlı fark (ham porcelain çıktısı). a/b: { hash, path }.
  async wordDiff(dir, a, b, { context = 3 } = {}) {
    this._checkHash(a.hash); this._checkHash(b.hash);
    for (const p of [a.path, b.path]) if (!p || String(p).startsWith('-')) throw new GitError('Geçersiz yol');
    const u = Math.max(0, Math.min(50, Number(context) | 0));
    return this.run(dir, ['diff', '--no-color', '--no-ext-diff', '--word-diff=porcelain', '-U' + u, a.hash + ':' + a.path, b.hash + ':' + b.path]);
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
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
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

  /* ---- Aşama 4: dışa aktarma, uzak depo ---- */

  _checkAnyRef(name) {
    const n = String(name);
    if (n !== 'HEAD' && (!ANY_REF_RE.test(n) || n.includes('..') || n.endsWith('/') || n.endsWith('.lock'))) throw new GitError('Geçersiz ref adı');
  }

  _checkRemote(name, url) {
    if (!REMOTE_NAME_RE.test(String(name)) || String(name).includes('..') || String(name).endsWith('.lock')) throw new GitError('Geçersiz uzak depo adı');
    if (url !== undefined && (!String(url) || String(url).startsWith('-') || /[\x00-\x1f\x7f]/.test(String(url)))) throw new GitError('Geçersiz URL');
  }

  async currentBranch(dir) {
    try { return (await this.run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim() || null; } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return null;
    }
  }

  // commit içindeki rel altındaki dosya yolları (rel dosya ya da klasör olabilir). Yoksa [].
  async lsTree(dir, commit, rel) {
    this._checkHash(commit);
    if (!rel || String(rel).startsWith('-')) throw new GitError('Geçersiz yol');
    try {
      return (await this.run(dir, ['ls-tree', '-r', '--name-only', commit, '--', rel])).split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean);
    } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return [];
    }
  }

  // commit'teki dosya içeriği; yoksa null.
  async showAt(dir, commit, rel) {
    this._checkHash(commit);
    try { return await this.showFile(dir, commit, rel); } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return null;
    }
  }

  // Verilen yollardaki (boşsa tüm ağaçtaki) kirli dosyalar. `.pp/` izlenmeyenleri sayılmaz.
  async isClean(dir, rels = []) {
    const specs = rels.length ? rels : ['.'];
    for (const r of specs) if (String(r).startsWith('-')) throw new GitError('Geçersiz yol');
    const out = await this.run(dir, ['status', '--porcelain=v1', '-z', '-uall', '--', ...specs, ':(exclude).pp']);
    return parseStatus(out).map((f) => f.path);
  }

  async isAncestor(dir, a, b) {
    this._checkHash(a); this._checkHash(b);
    try { await this.run(dir, ['merge-base', '--is-ancestor', a, b]); return true; } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return false;
    }
  }

  // [{ name, url }]
  async remotes(dir) {
    let out = '';
    try { out = await this.run(dir, ['config', '--local', '--get-regexp', '^remote\\..*\\.url$']); } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return [];
    }
    const list = [];
    for (const line of out.split('\n')) {
      const m = /^remote\.(.+)\.url (.*)$/.exec(line.replace(/\r$/, ''));
      if (m) list.push({ name: m[1], url: m[2] });
    }
    return list;
  }

  async addRemote(dir, name, url) {
    this._checkRemote(name, url);
    await this.run(dir, ['remote', 'add', '--', name, url]);
  }

  async setRemoteUrl(dir, name, url) {
    this._checkRemote(name, url);
    await this.run(dir, ['remote', 'set-url', '--', name, url]);
  }

  // 'origin/main' ya da null.
  async upstream(dir) {
    try { return (await this.run(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim() || null; } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return null;
    }
  }

  // HEAD...ref karşılaştırması. ref yoksa { ahead: 0, behind: 0 }.
  async aheadBehind(dir, ref) {
    this._checkAnyRef(ref);
    try {
      const [a, b] = (await this.run(dir, ['rev-list', '--left-right', '--count', 'HEAD...' + ref])).trim().split(/\s+/).map(Number);
      return { ahead: a || 0, behind: b || 0 };
    } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return { ahead: 0, behind: 0 };
    }
  }

  // Dalı ve verilen tag'leri tek işlemde gönderir. Hata: GitError (netCode ile).
  async push(dir, { remote, branch, tags = [], setUpstream = false, atomic = true, interactive = false } = {}) {
    this._checkRemote(remote); this._checkAnyRef(branch);
    for (const t of tags) this._checkRef(t);
    const build = (useAtomic) => ['push', '--porcelain', ...(useAtomic ? ['--atomic'] : []), '--follow-tags', ...(setUpstream ? ['-u'] : []),
      remote, 'refs/heads/' + branch + ':refs/heads/' + branch, ...tags.map((t) => 'refs/tags/' + t + ':refs/tags/' + t)];
    try {
      await this._net(dir, build(atomic), { interactive, timeout: 120000 });
    } catch (e) {
      if (atomic && e.netCode === 'atomikYok') {
        await this._net(dir, build(false), { interactive, timeout: 120000 });
      } else throw e;
    }
    return { ok: true };
  }

  // Salt okuma: uzak dallar refs/remotes altına, uzak paket/ ve prompt/ tag'leri refs/pp/uzak/<remote>/ altına alınır.
  async fetch(dir, remote, { interactive = false, timeout = interactive ? 60000 : 30000 } = {}) {
    this._checkRemote(remote);
    await this._net(dir, ['fetch', '--no-tags', '--no-recurse-submodules', remote,
      '+refs/heads/*:refs/remotes/' + remote + '/*',
      '+refs/tags/paket/*:refs/pp/uzak/' + remote + '/paket/*',
      '+refs/tags/prompt/*:refs/pp/uzak/' + remote + '/prompt/*'], { interactive, timeout });
  }

  // refs/tags dışındaki ad alanları için: [{ name (tam ad), object, commit }]
  async listRefs(dir, refPrefix) {
    this._checkRef(refPrefix, { prefix: true });
    const out = await this.run(dir, ['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(*objectname)%1e', refPrefix]);
    const list = [];
    for (const rec of out.split('\x1e')) {
      const r = rec.replace(/\r/g, '').replace(/^\n+/, '');
      if (!r.trim()) continue;
      const [name, object, peeled] = r.split('\x1f');
      list.push({ name, object, commit: peeled || object });
    }
    return list;
  }

  // from..to aralığındaki commit'ler (ref adları doğrulanır).
  async logRange(dir, from, to, limit = 50) {
    this._checkAnyRef(from); this._checkAnyRef(to);
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new GitError('Geçersiz limit');
    try {
      return parseLogOutput(await this.run(dir, ['log', '-n', String(n), '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s', from + '..' + to]));
    } catch (e) {
      if (/unknown revision|bad revision|bad default revision|does not have any commits/i.test(e.message)) return [];
      throw e;
    }
  }

  async refExists(dir, ref) {
    this._checkAnyRef(ref);
    try { await this.run(dir, ['rev-parse', '--verify', '-q', ref + '^{commit}']); return true; } catch (e) {
      if (e instanceof GitNotFoundError || e.code === 'aracReposu') throw e;
      return false;
    }
  }

  async mergeFfOnly(dir, ref) {
    this._checkAnyRef(ref);
    await this.run(dir, ['merge', '--ff-only', ref]);
  }

  // CAS: HEAD hâlâ `expect` ise `to` konumuna döner (çalışma ağacı değişikliklerini korur).
  async resetKeep(dir, { expect, to } = {}) {
    this._checkHash(expect); this._checkHash(to);
    const head = await this.headCommit(dir);
    if (head !== expect) throw new GitError('HEAD beklenen commit değil, geri alma yapılmadı');
    await this.run(dir, ['reset', '--keep', to]);
  }

  // Yalnızca yoksa oluşturur (var olan tag'i ezmez). object commit ya da tag nesnesidir.
  async createTagAt(dir, name, object) {
    this._checkRef(name); this._checkHash(object);
    await this.run(dir, ['update-ref', 'refs/tags/' + name, object, ZERO_OID]);
  }

  // parentDir altında dirName klasörüne klonlar. Hata: GitError (netCode ile).
  async clone(parentDir, url, dirName, { interactive = true, timeout = 300000 } = {}) {
    if (!String(url) || String(url).startsWith('-')) throw new GitError('Geçersiz URL');
    if (!dirName || String(dirName).startsWith('-') || /[\\/]/.test(dirName)) throw new GitError('Geçersiz klasör adı');
    await this._net(parentDir, ['clone', '--no-recurse-submodules', '--origin', 'origin', '--', url, dirName], { interactive, timeout });
  }
}

module.exports = { GitService, GitError, GitNotFoundError, parseStatus, parseLogOutput, parseTagRefs, parseChangeLog, parseWordDiff, classifyGitNetError, classifyGitError, HASH_RE };
