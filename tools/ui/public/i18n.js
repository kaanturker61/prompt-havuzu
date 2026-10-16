(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('async_hooks').AsyncLocalStorage, function (lang) {
      return lang === 'en' ? require('./lang/en.js') : require('./lang/tr.js');
    });
  } else {
    root.I18n = factory(null, function (lang) {
      return lang === 'en' ? root.PP_LANG_EN : root.PP_LANG_TR;
    });
  }
})(typeof self !== 'undefined' ? self : this, function (AsyncLocalStorage, loadDictionary) {
  'use strict';

  /** Summary: Desteklenen dil kodları. */
  const LANGUAGES = Object.freeze(['tr', 'en']);
  /** Summary: Bağlam yokken ve eksik anahtarda kullanılan dil. */
  const DEFAULT_LANGUAGE = 'tr';
  /** Summary: Dil koduna karşılık gelen yerel ayar. */
  const LOCALE = Object.freeze({ tr: 'tr-TR', en: 'en-US' });
  /** Summary: Yer tutucu biçimi: {ad}. */
  const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g;
  /** Summary: HTML kaçış tablosu. */
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** Summary: Nesnenin kendi özelliği mi (prototip anahtarlarını dışlar). */
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Summary: Metni HTML için kaçışlar. */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
  }

  /** Summary: Kaçışsız eklenecek güvenilir HTML parçası. */
  class Raw {
    constructor(html) { this.html = String(html); }
    toString() { return this.html; }
  }

  /** Summary: Geçerli dil kodunu döner, değilse null. */
  function normalize(lang) {
    return LANGUAGES.indexOf(lang) >= 0 ? lang : null;
  }

  /** Summary: Ayar ve tarayıcı dilinden arayüz dilini çözer. */
  function resolve(setting, navigatorLang) {
    const chosen = normalize(setting);
    if (chosen) return chosen;
    return /^tr(?:[-_]|$)/i.test(String(navigatorLang || '')) ? 'tr' : 'en';
  }

  /** Summary: Bir sözlük kümesi için bağımsız çeviri örneği kurar. */
  function build(dictionaryOf) {
    const store = AsyncLocalStorage ? new AsyncLocalStorage() : null;
    const pluralRules = {};
    const missing = [];
    let browserLanguage = DEFAULT_LANGUAGE;

    /** Summary: Geçerli dil: Node'da ALS bağlamı, tarayıcıda setLanguage değeri. */
    function current() {
      if (store) return store.getStore() || DEFAULT_LANGUAGE;
      return browserLanguage;
    }

    /** Summary: fn'i verilen dil bağlamında çalıştırır (tarayıcıda yalnızca eşzamanlı). */
    function run(lang, fn) {
      const language = normalize(lang) || DEFAULT_LANGUAGE;
      if (store) return store.run(language, fn);
      const previous = browserLanguage;
      browserLanguage = language;
      try { return fn(); } finally { browserLanguage = previous; }
    }

    /** Summary: Tarayıcıda geçerli dili ayarlar, sunucuda kullanılamaz. */
    function setLanguage(lang) {
      if (store) throw new Error('setLanguage yalnızca tarayıcıda kullanılır; sunucuda I18n.run kullan');
      browserLanguage = normalize(lang) || DEFAULT_LANGUAGE;
      return browserLanguage;
    }

    /** Summary: Dilin yerel ayar kodu (verilmezse geçerli dil). */
    function locale(lang) {
      return LOCALE[normalize(lang) || current()];
    }

    /** Summary: Eksik anahtarı yinelenmeden missing listesine ekler. */
    function noteMissing(lang, key) {
      const entry = lang + ':' + key;
      if (missing.indexOf(entry) < 0) missing.push(entry);
    }

    /** Summary: Dil için çoğul kural nesnesini önbellekten verir. */
    function rulesFor(lang) {
      const code = LOCALE[lang];
      return pluralRules[code] || (pluralRules[code] = new Intl.PluralRules(code));
    }

    /** Summary: Anahtarın o dildeki metin şablonunu bulur, yoksa undefined. */
    function templateOf(lang, key, params) {
      const dictionary = dictionaryOf(lang);
      if (!dictionary || !hasOwn(dictionary, key)) return undefined;
      const value = dictionary[key];
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return undefined;
      const count = params ? params.count : undefined;
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new TypeError('I18n: "' + key + '" çoğul anahtarı için params.count (sayı) gerekli');
      }
      const category = rulesFor(lang).select(count);
      const text = hasOwn(value, category) ? value[category] : value.other;
      return typeof text === 'string' ? text : undefined;
    }

    /** Summary: Yer tutucuları tek geçişte, işlevli değiştiriciyle doldurur. */
    function fill(text, params, html) {
      if (!params) return text;
      return text.replace(PLACEHOLDER_RE, function (match, name) {
        if (!hasOwn(params, name)) return match;
        const value = params[name];
        if (value === undefined || value === null) return match;
        if (value instanceof Raw) return value.html;
        return html ? escapeHtml(value) : String(value);
      });
    }

    /** Summary: İstenen dil, tr, anahtar sırasıyla metni üretir. */
    function translate(key, params, opts, html) {
      const id = String(key);
      const lang = (opts && normalize(opts.lang)) || current();
      let text = templateOf(lang, id, params);
      if (text === undefined) {
        noteMissing(lang, id);
        if (lang !== DEFAULT_LANGUAGE) {
          text = templateOf(DEFAULT_LANGUAGE, id, params);
          if (text === undefined) noteMissing(DEFAULT_LANGUAGE, id);
        }
      }
      if (text === undefined) return html ? escapeHtml(id) : id;
      return fill(text, params, html);
    }

    /** Summary: Düz metin çevirisi. */
    function tx(key, params, opts) { return translate(key, params, opts, false); }

    /** Summary: HTML çevirisi; parametreler kaçışlanır, raw() ile verilenler kaçışlanmaz. */
    function th(key, params, opts) { return translate(key, params, opts, true); }

    /** Summary: Güvenilir HTML parametresi işaretler. */
    function raw(html) { return new Raw(html); }

    return {
      LANGUAGES, DEFAULT_LANGUAGE, LOCALE, missing,
      tx, th, raw, resolve, run, current, setLanguage, locale
    };
  }

  /** Summary: Varsayılan örnek; create ile verilen sözlüklerden bağımsız örnek kurulur. */
  const api = build(loadDictionary);
  api.create = function (dictionaries) {
    return build(function (lang) { return dictionaries ? dictionaries[lang] : undefined; });
  };
  return api;
});
