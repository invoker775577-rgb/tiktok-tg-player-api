/**
 * TikTok TG Player — API (Render Web Service)
 *
 * Порт Cloudflare Worker'а на Node/Express — чтобы API жил на том же домене
 * (render.com), что и фронт. Нужно потому, что workers.dev заблокирован
 * у части операторов (подтверждено: Беларусь, ERR_CONNECTION_TIMED_OUT).
 *
 * Хранилище: библиотека и плейлисты — в файле library.json на диске Render
 * (диск эфемерный на free-тарифе — переживает рестарт процесса, но не redeploy;
 * это ок, т.к. uploader.py каждый раз шлёт актуальную копию через /api/ingest).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const INGEST_KEY = process.env.INGEST_KEY;
const DATA_FILE = path.join(__dirname, 'library.json');

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задан — установи переменную окружения на Render');
  process.exit(1);
}

const TG_API = 'https://api.telegram.org';
const FILE_PATH_TTL_MS = 30 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('access-control-allow-origin', '*');
  res.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.header('access-control-allow-headers', 'content-type, x-ingest-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Хранилище на диске ───────────────────────────────────────
function loadLibrary() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { videos: [], playlists: {} };
  }
}

function saveLibrary(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
}

// ── Кэш file_path (getFile) в памяти процесса ───────────────
const filePathCache = new Map(); // fileId -> { path, expires }

function isValidFileId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id);
}

async function resolveFilePath(fileId) {
  const cached = filePathCache.get(fileId);
  if (cached && cached.expires > Date.now()) return cached.path;

  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.ok || !data.result?.file_path) return null;

  const filePath = data.result.file_path;
  filePathCache.set(fileId, { path: filePath, expires: Date.now() + FILE_PATH_TTL_MS });
  return filePath;
}

// ── Роуты ────────────────────────────────────────────────────
app.get('/api/library', (req, res) => {
  res.json(loadLibrary());
});

app.post('/api/playlists', (req, res) => {
  const playlists = req.body;
  if (playlists === null || typeof playlists !== 'object' || Array.isArray(playlists)) {
    return res.status(400).json({ ok: false, error: 'expected object' });
  }
  const lib = loadLibrary();
  lib.playlists = playlists;
  saveLibrary(lib);
  res.json({ ok: true });
});

app.post('/api/ingest', (req, res) => {
  const key = req.header('x-ingest-key');
  if (!INGEST_KEY || key !== INGEST_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body;
  if (!Array.isArray(body.videos)) {
    return res.status(400).json({ ok: false, error: 'videos must be an array' });
  }

  const lib = loadLibrary();
  lib.videos = body.videos;
  if (body.playlists && typeof body.playlists === 'object' && !Array.isArray(body.playlists)) {
    lib.playlists = body.playlists;
  }
  saveLibrary(lib);

  res.json({ ok: true, count: body.videos.length });
});

app.get('/api/video/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  if (!isValidFileId(fileId)) return res.status(400).send('bad file_id');

  let filePath = await resolveFilePath(fileId);
  if (!filePath) return res.status(404).send('file not found');

  const range = req.header('range');
  const fetchUpstream = () =>
    fetch(`${TG_API}/file/bot${BOT_TOKEN}/${filePath}`, { headers: range ? { range } : {} });

  let upstream = await fetchUpstream();

  if (upstream.status === 404 || upstream.status === 410) {
    filePathCache.delete(fileId);
    filePath = await resolveFilePath(fileId);
    if (!filePath) return res.status(404).send('file not found');
    upstream = await fetchUpstream();
  }

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(502).send('upstream error');
  }

  res.status(upstream.status);
  res.set('content-type', 'video/mp4');
  res.set('accept-ranges', 'bytes');
  res.set('cache-control', 'public, max-age=3600');
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }

  const reader = upstream.body.getReader();
  const pump = async () => {
    const { done, value } = await reader.read();
    if (done) return res.end();
    res.write(Buffer.from(value));
    pump();
  };
  pump().catch(() => res.end());
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
