'use strict';
/* Geri alma adımları yığını. Adımlar ters sırada çalışır; biri hata verse de diğerleri çalışır. */

const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

class UndoStack {
  constructor() { this._steps = []; }

  get size() { return this._steps.length; }

  push(fn) {
    if (typeof fn !== 'function') throw new TypeError(tx('err.undo.stepNotFunction'));
    this._steps.push(fn);
  }

  // Hata olursa tümü AggregateError içinde toplanıp fırlatılır.
  async rollback() {
    const errors = [];
    while (this._steps.length) {
      const fn = this._steps.pop();
      try { await fn(); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw new AggregateError(errors, tx('err.undo.rollbackFailed', { count: errors.length }));
  }

  // Başarı durumunda adımlar unutulur.
  clear() { this._steps.length = 0; }
}

module.exports = { UndoStack };
