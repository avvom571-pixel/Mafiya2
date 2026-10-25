const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'storage.json');
fs.mkdirSync(DATA_DIR, {recursive:true});
app.disable('x-powered-by');
app.use(express.json({limit:'256kb'}));
app.use(express.static(path.join(__dirname, 'public'), {extensions:['html']}));

let store = {};
try { store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(async () => {
    const temp = DB_FILE + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(store), 'utf8');
    await fs.promises.rename(temp, DB_FILE);
  });
  return writeQueue;
}
function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 250 &&
    !key.includes('\0') && !key.includes('..');
}
app.get('/api/health', (_req,res) => res.json({ok:true, service:'night-city-online'}));
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
app.put('/api/storage/:key', async (req,res,next) => {
  try {
    const key = req.params.key;
    if (!validKey(key)) return res.status(400).json({error:'Invalid key'});
    // Client sends a JSON-serialized value, matching the original front-end storage API.
    let value = req.body;
    store[key] = value;
    await persist();
    res.json({ok:true});
  } catch (e) { next(e); }
});
app.use((err,_req,res,_next) => {
  console.error(err);
  res.status(500).json({error:'Internal server error'});
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Night City Mafia server listening on port ${PORT}`);
  console.log(`Persistent data file: ${DB_FILE}`);
});
