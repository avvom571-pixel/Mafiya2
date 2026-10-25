
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));

const publicDir = path.join(__dirname, "public");
const rootIndex = path.join(__dirname, "index.html");
const publicIndex = path.join(publicDir, "index.html");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dataFile = path.join(dataDir, "storage.json");

fs.mkdirSync(dataDir, { recursive: true });

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function writeStore(store) {
  const tempFile = dataFile + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, dataFile);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "night-city-online" });
});

app.get("/api/storage", (req, res) => {
  try {
    const store = readStore();
    const prefix = String(req.query.prefix || "");
    const result = {};

    for (const [key, value] of Object.entries(store)) {
      if (key.startsWith(prefix)) result[key] = value;
    }

    res.json(result);
  } catch (error) {
    console.error("Storage read error:", error);
    res.status(500).json({ error: "Storage read failed" });
  }
});

app.get("/api/storage/:key", (req, res) => {
  try {
    const store = readStore();
    const key = req.params.key;

    if (!Object.prototype.hasOwnProperty.call(store, key)) {
      return res.status(404).json({ error: "Key not found" });
    }

    res.json({ key, value: store[key] });
  } catch (error) {
    console.error("Storage read error:", error);
    res.status(500).json({ error: "Storage read failed" });
  }
});

app.put("/api/storage/:key", (req, res) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(req.body, "value")) {
      return res.status(400).json({ error: "Missing value" });
    }

    const store = readStore();
    store[req.params.key] = req.body.value;
    writeStore(store);

    res.json({ ok: true, key: req.params.key });
  } catch (error) {
    console.error("Storage write error:", error);
    res.status(500).json({ error: "Storage write failed" });
  }
});

app.delete("/api/storage/:key", (req, res) => {
  try {
    const store = readStore();
    delete store[req.params.key];
    writeStore(store);
    res.json({ ok: true });
  } catch (error) {
    console.error("Storage delete error:", error);
    res.status(500).json({ error: "Storage delete failed" });
  }
});

app.use(express.static(publicDir));

app.get("/{*splat}", (req, res, next) =>  {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API endpoint not found" });
  }

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }

  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }

  next();
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Night City Mafia server listening on port ${PORT}`);
  console.log(`Persistent data file: ${dataFile}`);
});
