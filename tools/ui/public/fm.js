/* fm.js: frontmatter okuyucu/yazıcı. Hem Node (require) hem tarayıcıda (window.FM) çalışır.
 *
 * Tasarım kararı: bilinmeyen anahtarlar ve biçimlendirme olduğu gibi korunur.
 * Yalnızca değiştirilen anahtarların satırı yeniden yazılır, böylece git farkları küçük kalır.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY_RE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/;

  /** Summary: Yeni anahtarların eklendiği sıra. */
  const CANON = ['baslik', 'etiketler', 'projeler', 'durum', 'versiyon', 'olusturma', 'tur', 'paket',
    'name', 'komut_adi', 'description', 'aciklama', 'when_to_use', 'argument-hint', 'arguman_ipucu', 'arguments',
    'allowed-tools', 'tools', 'izinli_araclar', 'disallowed-tools', 'disallowedTools', 'model', 'effort',
    'disable-model-invocation', 'user-invocable', 'context', 'agent', 'background', 'paths', 'shell',
    'maxTurns', 'autoCompactWindow', 'skills', 'memory', 'omitClaudeMd', 'isolation', 'color',
    'license', 'compatibility', 'hooks', 'metadata', 'experimental'];

  /* ---------- metin yardımcıları ---------- */

  const TR = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
    'Ç': 'c', 'Ğ': 'g', 'İ': 'i', 'I': 'i', 'Ö': 'o', 'Ş': 's', 'Ü': 'u' };

  // Aramada büyük/küçük harf ve Türkçe karakter farkını yok sayar. Uzunluğu korur (snippet için).
  function fold(s) {
    return String(s).replace(/[^\x00-\x7f]/g, function (ch) {
      if (TR[ch]) return TR[ch];
      const d = ch.normalize('NFD')[0];
      return d && d.charCodeAt(0) < 128 ? d : ch;
    }).toLowerCase();
  }

  function slug(s) {
    const t = String(s).replace(/[çğıöşüÇĞİIÖŞÜ]/g, function (c) { return TR[c]; })
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return t || 'adsiz';
  }

  /* ---------- değer okuma ---------- */

  function unquote(s) {
    s = s.trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      return s.slice(1, -1).replace(/\\(["\\nt])/g, function (m, c) { return c === 'n' ? '\n' : c === 't' ? '\t' : c; });
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
    return s;
  }

  function splitInline(s) {
    const out = []; let cur = ''; let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; }
      else if (c === '"' || c === "'") { q = c; cur += c; }
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
  }

  /* Satır sonu yorumunu atar: tırnak dışında ve öncesinde boşluk olan ilk "#" ile sonrası.
   * Tırnak yalnızca değer ya da liste öğesi başında açılır ("it's" içindeki ' açmaz). */
  function stripComment(v) {
    let q = null;
    let atStart = true; // yeni bir değer/öğe başlayabilir mi (baş, "[" ve "," sonrası; boşluklar atlanır)
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (q) {
        if (q === '"' && c === '\\') i++;
        else if (c === q) { if (q === "'" && v[i + 1] === "'") i++; else q = null; }
        continue;
      }
      if (c === '#' && i > 0 && /\s/.test(v[i - 1])) return v.slice(0, i).replace(/\s+$/, '');
      if ((c === '"' || c === "'") && atStart) { q = c; atStart = false; continue; }
      if (c === '[' || c === ',') atStart = true;
      else if (!/\s/.test(c)) atStart = false;
    }
    return v;
  }

  function parseValue(lines) {
    const first = KEY_RE.exec(lines[0]);
    let v = (first[2] === undefined ? '' : first[2]).trim();
    const rest = lines.slice(1);
    if (v === '') {
      const items = rest.filter(function (l) { return /^\s*-\s+/.test(l); })
        .map(function (l) { return unquote(l.replace(/^\s*-\s+/, '')); });
      if (items.length) return items;
      return rest.map(function (l) { return l.trim(); }).filter(Boolean).join(' ');
    }
    if (/^[|>][+-]?$/.test(v)) {
      const t = rest.map(function (l) { return l.replace(/^\s+/, ''); });
      return (v[0] === '>' ? t.join(' ') : t.join('\n')).trim();
    }
    // Liste ve tırnaklı değerlerde yorum, kapanış denetiminden önce soyulur; düz metin dalı aşağıda olduğu gibi kalır.
    if (v[0] === '[' || v[0] === '"' || v[0] === "'") v = stripComment(v);
    if (v[0] === '[' && v[v.length - 1] === ']') return splitInline(v.slice(1, -1)).map(unquote);
    if (v[0] === '"' || v[0] === "'") return unquote(v);
    return unquote(v.replace(/\s+#.*$/, ''));
  }

  /* ---------- değer yazma ---------- */

  function needsQuote(s) {
    if (s === '') return true;
    if (/^\s|\s$/.test(s)) return true;
    if (/^[\[\]{}&*!|>'"%@`#,?:-]/.test(s)) return true;
    if (/:\s|:$|\s#/.test(s)) return true;
    if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
    if (/[\n\r\t]/.test(s)) return true;
    return false;
  }

  function quote(s) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '').replace(/\t/g, '\\t') + '"';
  }

  function fmtScalar(v) {
    const s = String(v);
    return needsQuote(s) ? quote(s) : s;
  }

  function fmtItem(v) {
    const s = String(v);
    return (needsQuote(s) || /[,\[\]"']/.test(s)) ? quote(s) : s;
  }

  /** Summary: Değeri tek satırlık YAML metnine çevirir. */
  function fmtValue(v) {
    if (Array.isArray(v)) return '[' + v.map(fmtItem).join(', ') + ']';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return fmtScalar(v);
  }

  /* ---------- ayrıştırma / yazma ---------- */

  function detectEol(s) {
    const crlf = (s.match(/\r\n/g) || []).length;
    const lf = (s.match(/\n/g) || []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
  }

  function parse(raw) {
    raw = String(raw == null ? '' : raw);
    let bom = '';
    if (raw.charCodeAt(0) === 0xFEFF) { bom = '\uFEFF'; raw = raw.slice(1); }
    const eol = detectEol(raw);
    const text = raw.replace(/\r\n/g, '\n');
    const res = { bom: bom, eol: eol, hasFm: false, entries: [], body: text };
    if (!/^---[ \t]*(\n|$)/.test(text)) return res;
    const lines = text.split('\n');
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^---[ \t]*$/.test(lines[i])) { end = i; break; }
    }
    if (end < 0) return res;
    res.hasFm = true;
    res.body = lines.slice(end + 1).join('\n');
    let cur = null;
    for (const line of lines.slice(1, end)) {
      const m = KEY_RE.exec(line);
      if (m) { cur = { key: m[1], lines: [line] }; res.entries.push(cur); }
      else if (cur && (line === '' || /^\s/.test(line) || /^-\s/.test(line))) cur.lines.push(line);
      else { cur = { key: null, lines: [line] }; res.entries.push(cur); }
    }
    for (const e of res.entries) if (e.key) e.value = parseValue(e.lines);
    return res;
  }

  function meta(p) {
    const m = {};
    for (const e of p.entries) if (e.key) m[e.key] = e.value;
    return m;
  }

  function isEmpty(v) { return v == null || v === '' || (Array.isArray(v) && v.length === 0); }

  function same(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    return String(a == null ? '' : a) === String(b == null ? '' : b);
  }

  // Birden fazla yazılmış anahtarlar: [{ key, count }] (ilk görülme sırasıyla). meta() ve set() sonuncuyu etkin sayar.
  function duplicateKeys(p) {
    const order = []; const counts = {};
    for (const e of p.entries) {
      if (!e.key) continue;
      if (!Object.prototype.hasOwnProperty.call(counts, e.key)) { counts[e.key] = 0; order.push(e.key); }
      counts[e.key]++;
    }
    return order.filter(function (k) { return counts[k] > 1; }).map(function (k) { return { key: k, count: counts[k] }; });
  }

  /* Yinelenen anahtarda meta() sonuncuyu okur; set() de sonuncuyu günceller, değer boşsa tüm kopyaları siler.
   * findLastIndex kullanılmaz (eski tarayıcılar): elle ters döngü. */
  function set(p, key, value) {
    let i = -1;
    for (let k = p.entries.length - 1; k >= 0; k--) { if (p.entries[k].key === key) { i = k; break; } }
    if (isEmpty(value)) {
      for (let k = p.entries.length - 1; k >= 0; k--) { if (p.entries[k].key === key) p.entries.splice(k, 1); }
      return p;
    }
    const line = key + ': ' + fmtValue(value);
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    const entry = { key: key, value: value, lines: [line] };
    if (i >= 0) {
      if (!same(p.entries[i].value, value)) p.entries[i] = entry;
      return p;
    }
    const ci = CANON.indexOf(key);
    let pos = p.entries.length;
    if (ci >= 0) {
      pos = 0;
      p.entries.forEach(function (e, idx) {
        const c = CANON.indexOf(e.key);
        if (c >= 0 && c < ci) pos = idx + 1;
      });
    }
    p.entries.splice(pos, 0, entry);
    p.hasFm = true;
    return p;
  }

  /** Summary: Anahtarı satır bazlı yeniden adlandırır; kaynak yoksa ya da hedef varsa false döner. */
  function rename(p, from, to) {
    if (from === to || !/^[A-Za-z_][\w-]*$/.test(to)) return false;
    const hits = p.entries.filter(function (e) { return e.key === from; });
    if (!hits.length || p.entries.some(function (e) { return e.key === to; })) return false;
    for (const e of hits) {
      e.lines[0] = e.lines[0].replace(/^[A-Za-z_][\w-]*/, function () { return to; });
      e.key = to;
    }
    return true;
  }

  /** Summary: Gövdeyi yazar; ön yüz varsa ya da metin "---" ile başlıyorsa başa boş satır koyar. */
  function setBody(p, text) {
    text = String(text == null ? '' : text);
    p.body = (p.entries.length || /^---[ \t]*(\n|$)/.test(text)) ? '\n' + text : text;
    return p;
  }

  function stringify(p) {
    const head = p.entries.reduce(function (acc, e) { return acc.concat(e.lines); }, []).join('\n');
    let out = p.entries.length ? '---\n' + head + '\n---\n' + p.body : p.body;
    if (p.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
    return (p.bom || '') + out;
  }

  /* ---------- {{değişken}} yer tutucuları ---------- */

  const PH_RE = /\{\{\s*([^{}\n]+?)\s*\}\}/g;

  function placeholders(text) {
    const seen = new Set(); let m;
    const re = new RegExp(PH_RE.source, 'g');
    while ((m = re.exec(text))) seen.add(m[1]);
    return Array.from(seen);
  }

  function fill(text, vars) {
    return text.replace(new RegExp(PH_RE.source, 'g'), function (all, k) {
      return (vars[k] !== undefined && vars[k] !== '') ? vars[k] : all;
    });
  }

  return { parse: parse, stringify: stringify, set: set, meta: meta, fold: fold, slug: slug,
    fmtScalar: fmtScalar, fmtValue: fmtValue, rename: rename, setBody: setBody, placeholders: placeholders, fill: fill, same: same, CANON: CANON, stripComment: stripComment, duplicateKeys: duplicateKeys };
});
