'use strict';
/* Uzak depo durumu: <marketplace>/.git/pp-state.json. Makineye özgüdür, klonla taşınmaz ve
 * `git status`ta görünmez (izlenmeyen dosya ileri sarmayı engellemesin diye .git içinde tutulur). */

const fsp = require('fs').promises;
const path = require('path');

const EMPTY = () => ({ pendingTags: [], lastCheck: null });

class StateStore {
  _file(dir) { return path.join(dir, '.git', 'pp-state.json'); }

  async get(dir) {
    try {
      const raw = JSON.parse(await fsp.readFile(this._file(dir), 'utf8'));
      return {
        pendingTags: Array.isArray(raw.pendingTags) ? raw.pendingTags.filter((t) => typeof t === 'string') : [],
        lastCheck: raw.lastCheck && typeof raw.lastCheck === 'object' ? raw.lastCheck : null
      };
    } catch (e) { return EMPTY(); }
  }

  async _save(dir, st) {
    const file = this._file(dir);
    const tmp = path.join(path.dirname(file), '.pp-state.json.pp-tmp');
    await fsp.writeFile(tmp, JSON.stringify(st, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, file);
  }

  async addPending(dir, tag) {
    const st = await this.get(dir);
    if (!st.pendingTags.includes(tag)) st.pendingTags.push(tag);
    await this._save(dir, st);
  }

  async removePending(dir, tags) {
    const drop = new Set([].concat(tags));
    const st = await this.get(dir);
    st.pendingTags = st.pendingTags.filter((t) => !drop.has(t));
    await this._save(dir, st);
  }

  async setLastCheck(dir, lastCheck) {
    const st = await this.get(dir);
    st.lastCheck = lastCheck;
    await this._save(dir, st);
  }
}

module.exports = { StateStore };
