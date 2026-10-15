'use strict';
/* HTTP testleri için ortak başlatıcı: server.js alt süreç olarak, geçici klasör + PP_CONFIG ile başlatılır.
 * Gerçek kullanıcı ayarına, gerçek library köküne ve araç reposunun git durumuna dokunmaz. */

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { gitEnv } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/* Sunucuyu başlatır. Dönüş: { child, cfg, call, logs, stop }.
 * identity false ise git kimliği tanımsızdır (commit needIdentity ile reddedilir); bu durumda aynı tmp için gitEnv'i yeniden çağırma (ayar dosyası ezilir).
 * call(method, url, body, { headers, raw }): raw verilirse gövde olduğu gibi (JSON.stringify edilmeden) gönderilir. */
async function startServer(tmp, { identity = true } = {}) {
  const port = await freePort();
  const cfg = path.join(tmp, 'cfg', 'config.json');
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
    env: { ...process.env, ...gitEnv(tmp, { identity }), PP_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let out = ''; let err = '';
  child.stderr.on('data', (b) => { err += b; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Sunucu zamanında başlamadı: ' + out + err)), 30000);
    child.stdout.on('data', (b) => { out += b; if (/çalışıyor: http:\/\/localhost:(\d+)/.test(out)) { clearTimeout(t); resolve(); } });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error('Sunucu kapandı (' + c + '): ' + out + err)); });
  });
  const base = 'http://127.0.0.1:' + port;
  async function call(method, url, body, { headers = {}, raw } = {}) {
    const h = { ...headers };
    if (method !== 'GET' && !('X-PP' in h)) h['X-PP'] = '1';
    if (h['X-PP'] === null) delete h['X-PP'];
    let payload;
    if (raw !== undefined) { h['Content-Type'] = 'application/json'; payload = raw; }
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: r.status, data, text };
  }
  return {
    child, cfg, call, base,
    logs: () => ({ out, err }),
    stop: () => new Promise((res) => { child.once('exit', res); child.kill(); setTimeout(res, 3000); })
  };
}

/* Library kökü + bir marketplace kurar (HTTP üzerinden). Dönüş: { lib, mk, name }.
 * commit: true ise iskelet ilk commit olarak atılır (yayın/sürüm testleri için). */
async function setupMarketplace(srv, tmp, { name = 'mk', commit = false } = {}) {
  const lib = path.join(tmp, 'PromptLibrary');
  let r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true });
  if (r.status !== 200) throw new Error('ayar: ' + r.text);
  r = await srv.call('POST', '/api/marketplaces', { name });
  if (r.status !== 200) throw new Error('marketplace: ' + r.text);
  const mk = path.join(lib, name);
  if (commit) {
    const { sh } = require('./helpers');
    const env = gitEnv(tmp);
    sh(mk, ['add', '-A'], env);
    sh(mk, ['commit', '-q', '-m', 'ilk'], env);
  }
  return { lib, mk, name };
}

module.exports = { startServer, setupMarketplace, freePort, SERVER };
