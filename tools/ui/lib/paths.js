'use strict';
/* Saf yol yardımcıları: ayar dosyası yolu, yol karşılaştırma, kök önerisi. */

const fs = require('fs');
const path = require('path');

const APP_DIR = 'prompt-havuzu';

// Kullanıcı ayar dosyasının yolu. PP_CONFIG tanımlıysa her şeyi geçersiz kılar.
function userConfigFile({ platform = process.platform, env = process.env, homedir } = {}) {
  const home = homedir || require('os').homedir();
  // Hedef platformun yol kurallarıyla birleştir (testler başka platformu taklit edebilir).
  const j = platform === 'win32' ? path.win32.join : path.posix.join;
  if (env.PP_CONFIG) return path.resolve(env.PP_CONFIG);
  if (platform === 'win32') {
    return j(env.APPDATA || j(home, 'AppData', 'Roaming'), APP_DIR, 'config.json');
  }
  if (platform === 'darwin' && !env.XDG_CONFIG_HOME) {
    return j(home, 'Library', 'Application Support', APP_DIR, 'config.json');
  }
  return j(env.XDG_CONFIG_HOME || j(home, '.config'), APP_DIR, 'config.json');
}

// Var olan en yakın üst klasörün gerçek yolunu bulur, kalan kısmı üstüne ekler.
function realish(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

function norm(p, caseInsensitive) {
  let s = realish(p).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += path.sep; // sürücü kökü
  return caseInsensitive ? s.toLowerCase() : s;
}

const defaultCI = () => process.platform === 'win32';

function samePath(a, b, { caseInsensitive = defaultCI() } = {}) {
  if (!a || !b) return false;
  return norm(a, caseInsensitive) === norm(b, caseInsensitive);
}

// child, parent'ın altında mı? Eşit yol false döner.
function isInside(child, parent, { caseInsensitive = defaultCI() } = {}) {
  if (!child || !parent) return false;
  const c = norm(child, caseInsensitive);
  const p = norm(parent, caseInsensitive);
  const rel = path.relative(p, c);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Windows'ta D:\ sürücüsü varsa orada bir library klasörü önerilir, aksi halde öneri yok.
function suggestedRoot({ platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform === 'win32' && exists('D:\\')) return 'D:\\PromptLibrary';
  return null;
}

function suggestedRootNote({ platform = process.platform } = {}) {
  return platform === 'win32' ? 'D:\\ sürücüsü bulunamadı. Library kökünü kendin seç.' : 'Library kökünü kendin seç.';
}

module.exports = { userConfigFile, samePath, isInside, suggestedRoot, suggestedRootNote, realish };
