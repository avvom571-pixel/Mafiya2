const express = require('express');
const fs = require('fs');
const path = require('path');
const Accounts = require('./accounts');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'storage.json');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // rooms unused for 12h are removed
fs.mkdirSync(DATA_DIR, {recursive:true});
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('etag', false); // no 304 / heuristic caching on phones

// CORS: lets the front-end work even if opened from another address (e.g. GitHub Pages)
app.use('/api', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit:'256kb', strict:false}));

// ---------- accounts (login + password, personal profiles) ----------
const remote = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Accounts.Remote(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN) : null;
console.log(remote ? 'Accounts: external storage (Upstash) enabled' : 'Accounts: local file only (lost on Render free restarts unless you add a Disk or Upstash)');
const accounts = new Accounts(path.join(DATA_DIR, 'accounts.json'), remote);
function bearer(req){ const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }
function auth(req, res, next){
  const user = accounts.authenticate(bearer(req));
  if(!user) return res.status(401).json({error:'Требуется вход в аккаунт.'});
  req.user = user; req.token = bearer(req);
  next();
}
function send(res, r){ res.status(r.status || 200).json(r); }
app.post('/api/auth/register', async (req,res) => {
  try{ const b = req.body || {}; send(res, await accounts.register({username:b.username, password:b.password, name:b.name, profile:b.profile, ip:req.ip})); }
  catch(e){ console.error(e); res.status(500).json({error:'Ошибка сервера.'}); }
});
app.post('/api/auth/login', async (req,res) => {
  try{ const b = req.body || {}; send(res, await accounts.login({username:b.username, password:b.password, ip:req.ip})); }
  catch(e){ console.error(e); res.status(500).json({error:'Ошибка сервера.'}); }
});
app.post('/api/auth/logout', auth, (req,res) => send(res, accounts.logout(req.token)));
app.post('/api/auth/password', auth, async (req,res) => {
  try{ const b = req.body || {}; send(res, await accounts.changePassword(req.user, req.token, b.oldPassword, b.newPassword)); }
  catch(e){ console.error(e); res.status(500).json({error:'Ошибка сервера.'}); }
});
app.get('/api/me', auth, (req,res) => send(res, accounts.me(req.user)));
app.put('/api/me', auth, (req,res) => send(res, accounts.setProfile(req.user, (req.body||{}).profile)));
app.get('/api/rating', auth, (_req,res) => res.json({players: accounts.rating()}));
// Front-end: normally public/index.html; falls back to ./index.html if it was uploaded to the repo root
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = [path.join(PUBLIC_DIR,'index.html'), path.join(__dirname,'index.html')].find(f => fs.existsSync(f));
console.log('Front-end:', INDEX_FILE ? INDEX_FILE : 'index.html NOT FOUND (upload public/index.html)');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, {
    extensions:['html'],
    setHeaders: (res, p) => {
      if (p.endsWith('.html') || p.endsWith('sw.js') || p.endsWith('manifest.json')) res.set('Cache-Control', 'no-cache');
      if (p.endsWith('manifest.json')) res.type('application/manifest+json');
    }
  }));
}
app.get('/', (_req, res) => {
  if (INDEX_FILE) { res.set('Cache-Control', 'no-cache'); return res.sendFile(INDEX_FILE); }
  res.status(500).type('text').send('index.html not found. The repository must contain public/index.html');
});

let store = {};
let meta = {}; // key -> last update timestamp
try {
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (saved && saved.store) { store = saved.store; meta = saved.meta || {}; }
  else store = saved || {};
} catch (_) {}
for (const k of Object.keys(store)) if (!meta[k]) meta[k] = Date.now();

let writeQueue = Promise.resolve();
let dirty = false;
function persist() {
  dirty = true;
  writeQueue = writeQueue.then(async () => {
    if (!dirty) return;
    dirty = false;
    const temp = DB_FILE + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify({store, meta}), 'utf8');
    await fs.promises.rename(temp, DB_FILE);
  }).catch(e => console.error('persist failed (data stays in memory):', e.message));
  return writeQueue;
}

// Remove old rooms (key prefix "room:CODE") that nobody touched for ROOM_TTL_MS
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  const codes = {};
  for (const k of Object.keys(store)) {
    const m = /^room:([^:]+)/.exec(k);
    if (!m) continue;
    codes[m[1]] = Math.max(codes[m[1]] || 0, meta[k] || 0);
  }
  let removed = false;
  for (const code of Object.keys(codes)) {
    if (codes[code] < cutoff) {
      for (const k of Object.keys(store)) {
        if (k === 'room:' + code || k.startsWith('room:' + code + ':')) { delete store[k]; delete meta[k]; removed = true; }
      }
    }
  }
  if (removed) persist();
}, 30 * 60 * 1000).unref();

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 250 &&
    !key.includes('\0') && !key.includes('..') &&
    !key.startsWith('profile:') && !key.startsWith('acct:');   // personal data is only reachable through the authenticated /api/me
}
app.get('/api/health', (_req,res) => res.json({ok:true, service:'night-city-online', keys:Object.keys(store).length}));
app.get('/api/storage', (req,res) => {
  const prefix = String(req.query.prefix || '');
  if (prefix.length > 250) return res.status(400).json({error:'Invalid prefix'});
  if (prefix.startsWith('profile:') || prefix.startsWith('acct:')) return res.json({keys:[]});
  res.json({keys:Object.keys(store).filter(k=>k.startsWith(prefix) && !k.startsWith('profile:') && !k.startsWith('acct:'))});
});
app.get('/api/storage/:key', (req,res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({error:'Invalid key'});
  if (!Object.prototype.hasOwnProperty.call(store,key)) return res.json({found:false});
  res.json({found:true,value:store[key]});
});
app.put('/api/storage/:key', (req,res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({error:'Invalid key'});
  store[key] = req.body;
  meta[key] = Date.now();
  persist();            // write to disk in background; do not make phones wait
  res.json({ok:true});
});
app.use((err,_req,res,_next) => {
  console.error(err);
  res.status(err.status || 500).json({error:'Internal server error'});
});
accounts.init().catch(e => console.error('accounts init failed', e.message)).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Night City Mafia server listening on port ${PORT}`);
    console.log(`Persistent data file: ${DB_FILE}`);
  });
});
