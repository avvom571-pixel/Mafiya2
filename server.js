const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'storage.json');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // rooms unused for 12h are removed
fs.mkdirSync(DATA_DIR, {recursive:true});
app.disable('x-powered-by');
app.set('etag', false); // no 304 / heuristic caching on phones

// CORS: lets the front-end work even if opened from another address (e.g. GitHub Pages)
app.use('/api', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit:'256kb', strict:false}));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions:['html'],
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); }
}));

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
    !key.includes('\0') && !key.includes('..');
}
app.get('/api/health', (_req,res) => res.json({ok:true, service:'night-city-online', keys:Object.keys(store).length}));
app.get('/api/storage', (req,res) => {
  const prefix = String(req.query.prefix || '');
  if (prefix.length > 250) return res.status(400).json({error:'Invalid prefix'});
  res.json({keys:Object.keys(store).filter(k=>k.startsWith(prefix))});
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Night City Mafia server listening on port ${PORT}`);
  console.log(`Persistent data file: ${DB_FILE}`);
});
