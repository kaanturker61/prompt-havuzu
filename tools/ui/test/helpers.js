'use strict';
/* Test yardımcıları: geçici klasörler ve izole git ortamı. Gerçek kullanıcı ayarlarına dokunmaz. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const gitAvailable = (() => { try { return spawnSync('git', ['--version']).status === 0; } catch (e) { return false; } })();

function tmpDir(prefix = 'pp-test-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }

// GIT_CONFIG_GLOBAL/NOSYSTEM ile izole git ortamı. identity false ise kimlik tanımsız kalır.
function gitEnv(dir, { identity = true } = {}) {
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, identity ? '' : '[user]\n\tuseConfigOnly = true\n');
  const env = { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, USERPROFILE: dir };
  if (identity) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
    });
  } else {
    // Ortamdan kalıtılan kimlik değişkenlerini boşalt; yapılandırma da boş.
    Object.assign(env, { GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' });
  }
  return env;
}

// Senkron git yardımcısı (testlerde hazırlık için).
function sh(cwd, args, env) {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' başarısız: ' + (r.stderr || r.stdout));
  return r.stdout;
}

// tmp/<name> altında main dallı boş bir depo kurar. env: gitEnv(tmp).
function makeRepo(tmp, name = 'repo') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const env = gitEnv(tmp);
  sh(dir, ['init', '-q'], env);
  sh(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'], env);
  return dir;
}

// Boş bare depo (uzak depo yerine). İçerik çalışma kopyasından push edilir.
function makeBare(tmp, name = 'uzak.git') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '--bare', '-q'], gitEnv(tmp));
  sh(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'], gitEnv(tmp));
  return dir;
}

/** Summary: index.html betik sırasıyla sözlükleri ve çekirdeği boş bir vm bağlamına yükler; tarayıcı kipi I18n döner. */
function browserI18n() {
  const pub = path.join(__dirname, '..', 'public');
  const ctx = vm.createContext({});
  for (const f of ['lang/tr.js', 'lang/en.js', 'i18n.js']) vm.runInContext(fs.readFileSync(path.join(pub, f), 'utf8'), ctx, { filename: f });
  return ctx.I18n;
}

/** Summary: vm bağlamları için çeviri global'leri: gerçek I18n, tx, th (browser: true ise tarayıcı kipi, setLanguage çalışır). */
function uiGlobals({ browser = false } = {}) {
  const I18n = browser ? browserI18n() : require('../public/i18n.js');
  return { I18n, tx: I18n.tx, th: I18n.th };
}

module.exports = { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeRepo, makeBare, browserI18n, uiGlobals };
