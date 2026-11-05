// Accounts: unique login + password, personal profile, sessions. Stored in DATA_DIR/accounts.json
const crypto = require('crypto');
const fs = require('fs');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;
const MAX_PROFILE_BYTES = 200 * 1024;
const FAIL_LIMIT = 8, REG_LIMIT = 30, FAIL_WINDOW = 15 * 60 * 1000;
const REMOTE_PREFIX = 'mafia:u:';

// Optional external storage (Upstash Redis REST). Render's free disk is wiped on every restart/deploy,
// so without this (or a paid Render Disk) accounts disappear when the server sleeps.
class Remote {
  constructor(url, token) { this.url = String(url).replace(/\/$/, ''); this.token = token; }
  async call(path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(this.url + path, { method: 'POST', signal: ctl.signal, headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('remote HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async cmd(args) { const j = await this.call('', args); if (j.error) throw new Error(j.error); return j.result; }
  async pipeline(cmds) { const j = await this.call('/pipeline', cmds); return j.map(x => { if (x.error) throw new Error(x.error); return x.result; }); }
}

class Accounts {
  constructor(file, remote) {
    this.file = file;
    this.remote = remote || null;
    this.remoteDirty = new Set();
    this.remoteTimer = null;
    this.db = { accounts: {}, profiles: {}, sessions: {} };
    this.fails = new Map();
    this.queue = Promise.resolve();
    this.dirty = false;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.accounts) this.db = Object.assign(this.db, d);
    } catch (_) {}
    this.cleanSessions();
  }
  async init() {
    if (!this.remote) return;
    try {
      const keys = await this.remote.cmd(['KEYS', REMOTE_PREFIX + '*']);
      if (Array.isArray(keys) && keys.length) {
        const accounts = {}, profiles = {};
        for (let i = 0; i < keys.length; i += 100) {
          const chunk = keys.slice(i, i + 100);
          const vals = await this.remote.cmd(['MGET', ...chunk]);
          chunk.forEach((k, j) => {
            try { const d = JSON.parse(vals[j]); const u = k.slice(REMOTE_PREFIX.length); if (d && d.a) { accounts[u] = d.a; profiles[u] = d.p || {}; } } catch (_) {}
          });
        }
        this.db.accounts = accounts; this.db.profiles = profiles;   // the remote copy is the source of truth
        console.log('accounts restored from remote storage:', Object.keys(accounts).length);
      } else if (Object.keys(this.db.accounts).length) {
        Object.keys(this.db.accounts).forEach(u => this.remoteDirty.add(u));   // first run: upload what we have
        this.flushRemote();
      }
    } catch (e) { console.error('remote storage unavailable, using local file only:', e.message); }
  }
  touch(username) {
    if (!this.remote) return;
    this.remoteDirty.add(username);
    if (!this.remoteTimer) this.remoteTimer = setTimeout(() => this.flushRemote(), 1500);
  }
  async flushRemote() {
    this.remoteTimer = null;
    const users = [...this.remoteDirty]; this.remoteDirty.clear();
    if (!users.length) return;
    try {
      await this.remote.pipeline(users.map(u => ['SET', REMOTE_PREFIX + u, JSON.stringify({ a: this.db.accounts[u], p: this.db.profiles[u] })]));
    } catch (e) {
      console.error('remote save failed, will retry:', e.message);
      users.forEach(u => this.remoteDirty.add(u));
      if (!this.remoteTimer) this.remoteTimer = setTimeout(() => this.flushRemote(), 15000);
    }
  }
  save() {
    this.dirty = true;
    this.queue = this.queue.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(this.db), { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    }).catch(e => console.error('accounts save failed (kept in memory):', e.message));
    return this.queue;
  }
  cleanSessions() {
    const now = Date.now();
    for (const h of Object.keys(this.db.sessions)) if (this.db.sessions[h].exp < now) delete this.db.sessions[h];
  }
  static normUser(u) { return String(u || '').trim().replace(/^@/, '').toLowerCase(); }
  static validUsername(u) { return /^[a-z0-9_.]{3,20}$/.test(u); }
  static validPassword(p) { return typeof p === 'string' && p.length >= 6 && p.length <= 100; }
  async hash(pw, salt) { return (await scrypt(pw, salt, 64)).toString('hex'); }
  static sha(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

  blocked(key, limit) {
    const f = this.fails.get(key);
    if (!f) return false;
    if (Date.now() - f.t > FAIL_WINDOW) { this.fails.delete(key); return false; }
    return f.n >= (limit || FAIL_LIMIT);
  }
  noteFail(key) {
    const f = this.fails.get(key);
    if (!f || Date.now() - f.t > FAIL_WINDOW) this.fails.set(key, { n: 1, t: Date.now() });
    else f.n++;
  }

  issueToken(username) {
    const token = crypto.randomBytes(32).toString('hex');
    this.db.sessions[Accounts.sha(token)] = { u: username, exp: Date.now() + SESSION_TTL, created: Date.now() };
    const mine = Object.entries(this.db.sessions).filter(([, s]) => s.u === username).sort((a, b) => a[1].created - b[1].created);
    while (mine.length > MAX_SESSIONS_PER_USER) delete this.db.sessions[mine.shift()[0]];
    return token;
  }
  authenticate(token) {
    if (!token) return null;
    const s = this.db.sessions[Accounts.sha(token)];
    if (!s || s.exp < Date.now() || !this.db.accounts[s.u]) return null;
    return { username: s.u, id: this.db.accounts[s.u].id };
  }
  sanitizeProfile(p, id, username, name) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    let json;
    try { json = JSON.stringify(p); } catch (_) { return null; }
    if (json.length > MAX_PROFILE_BYTES) return null;
    const out = JSON.parse(json);
    out.id = id; out.username = username;
    if (name) out.name = String(name).slice(0, 18);
    if (typeof out.name !== 'string') out.name = username;
    return out;
  }

  async register({ username, password, name, profile, ip }) {
    username = Accounts.normUser(username);
    if (!Accounts.validUsername(username)) return { status: 400, error: 'Логин: 3–20 символов, только латинские буквы, цифры, _ и точка.' };
    if (!Accounts.validPassword(password)) return { status: 400, error: 'Пароль: минимум 6 символов.' };
    if (this.db.accounts[username]) return { status: 409, error: 'Этот логин уже занят. Выберите другой.' };
    if (this.blocked('reg|' + ip, REG_LIMIT)) return { status: 429, error: 'Слишком много попыток. Подождите немного.' };
    this.noteFail('reg|' + ip); // registrations are rate-limited per IP as well
    if (Object.keys(this.db.accounts).length >= 5000) return { status: 503, error: 'Регистрация временно закрыта.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const id = 'u-' + crypto.randomBytes(9).toString('hex');
    const display = String(name || username).trim().slice(0, 18) || username;
    this.db.accounts[username] = { id, salt, hash: await this.hash(password, salt), created: Date.now() };
    const prof = this.sanitizeProfile(profile, id, username, display) || { id, username, name: display };
    this.db.profiles[username] = prof;
    const token = this.issueToken(username);
    this.save(); this.touch(username);
    return { status: 200, token, id, username, profile: prof };
  }
  async login({ username, password, ip }) {
    username = Accounts.normUser(username);
    const key = ip + '|' + username;
    if (this.blocked(key)) return { status: 429, error: 'Слишком много неверных попыток. Попробуйте через 15 минут.' };
    const a = this.db.accounts[username];
    const salt = a ? a.salt : 'x'.repeat(32);
    const h = await this.hash(String(password || ''), salt);
    const ok = a && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(a.hash, 'hex'));
    if (!ok) { this.noteFail(key); return { status: 401, error: 'Неверный логин или пароль.' }; }
    this.fails.delete(key);
    const token = this.issueToken(username);
    this.save();
    return { status: 200, token, id: a.id, username, profile: this.db.profiles[username] || { id: a.id, username, name: username } };
  }
  me(user) { return { status: 200, id: user.id, username: user.username, profile: this.db.profiles[user.username] || { id: user.id, username: user.username, name: user.username } }; }
  setProfile(user, profile) {
    const prof = this.sanitizeProfile(profile, user.id, user.username);
    if (!prof) return { status: 400, error: 'Некорректный профиль.' };
    this.db.profiles[user.username] = prof;
    this.save(); this.touch(user.username);
    return { status: 200, ok: true };
  }
  logout(token) { delete this.db.sessions[Accounts.sha(token)]; this.save(); return { status: 200, ok: true }; }
  async changePassword(user, token, oldPassword, newPassword) {
    if (!Accounts.validPassword(newPassword)) return { status: 400, error: 'Новый пароль: минимум 6 символов.' };
    const key = 'pw|' + user.username;
    if (this.blocked(key)) return { status: 429, error: 'Слишком много попыток. Попробуйте позже.' };
    const a = this.db.accounts[user.username];
    const h = await this.hash(String(oldPassword || ''), a.salt);
    if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(a.hash, 'hex'))) { this.noteFail(key); return { status: 401, error: 'Текущий пароль неверный.' }; }
    a.salt = crypto.randomBytes(16).toString('hex');
    a.hash = await this.hash(newPassword, a.salt);
    const keep = Accounts.sha(token);
    for (const h2 of Object.keys(this.db.sessions)) if (this.db.sessions[h2].u === user.username && h2 !== keep) delete this.db.sessions[h2];
    this.save(); this.touch(user.username);
    return { status: 200, ok: true };
  }
  rating() {
    return Object.entries(this.db.profiles).map(([username, p]) => ({
      username,
      name: String(p.name || username).slice(0, 18),
      avatar: String(p.avatar || '🕵️').slice(0, 8),
      points: Number(p.points) || 0,
      games: Number(p.games) || 0,
      wins: Number(p.wins) || 0,
      history: (Array.isArray(p.history) ? p.history : []).slice(0, 40).map(h => ({ ts: Number(h.ts) || 0, gain: Number(h.gain) || 0 }))
    }));
  }
}
module.exports = Accounts;
module.exports.Remote = Remote;
