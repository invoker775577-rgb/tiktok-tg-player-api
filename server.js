/**
 * TikTok TG Player — API (Render Web Service)
 *
 * Порт Cloudflare Worker'а на Node/Express — чтобы API жил на том же домене
 * (render.com), что и фронт. Нужно потому, что workers.dev заблокирован
 * у части операторов (подтверждено: Беларусь, ERR_CONNECTION_TIMED_OUT).
 *
 * Хранилище: библиотека и плейлисты держатся в памяти процесса (быстрые
 * ответы), а на постоянку пишутся в library.json файла в GitHub-репозитории
 * через GitHub Contents API. При каждом старте процесс подтягивает файл
 * с GitHub заново — так библиотека переживает ЛЮБОЙ рестарт контейнера,
 * а не только редеплой.
 *
 * ВАЖНО: диск Render (fs.writeFileSync в локальный файл) — эфемерный.
 * Он стирается при каждом рестарте процесса (сон/пробуждение, не только
 * при новом деплое) — так один раз уже потерялась вся библиотека.
 * GitHub — единственное постоянное хранилище в этой архитектуре.
 */

const express = require('express');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const INGEST_KEY = process.env.INGEST_KEY;

// GitHub — постоянное хранилище library.json
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPO || 'invoker775577-rgb/tiktok-tg-player';
const GH_PATH = process.env.GITHUB_LIBRARY_PATH || 'api-render/library.json';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'master';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задан — установи переменную окружения на Render');
  process.exit(1);
}
if (!GH_TOKEN) {
  console.error('GITHUB_TOKEN не задан — без него библиотека не переживёт рестарт. Установи переменную окружения на Render.');
  process.exit(1);
}

const TG_API = 'https://api.telegram.org';
const GH_API = `https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}`;
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

// ── Хранилище: память процесса + GitHub как постоянный бэкенд ─
let library = { videos: [], playlists: {} };
let librarySha = null; // sha текущего файла на GitHub — нужен для PUT (обновление)

function ghHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

/** Подтягивает library.json с GitHub в память. Вызывается при старте процесса. */
async function loadLibraryFromGitHub() {
  try {
    const res = await fetch(`${GH_API}?ref=${GH_BRANCH}`, { headers: ghHeaders() });

    if (res.status === 404) {
      console.log('library.json ещё не существует на GitHub — стартуем с пустой библиотекой');
      librarySha = null;
      return;
    }
    if (!res.ok) {
      console.error(`GitHub API вернул ${res.status} при чтении library.json — библиотека останется пустой до /api/ingest`);
      return;
    }

    const data = await res.json();
    librarySha = data.sha;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = JSON.parse(content);

    library = {
      videos: Array.isArray(parsed.videos) ? parsed.videos : [],
      playlists: parsed.playlists && typeof parsed.playlists === 'object' ? parsed.playlists : {},
    };
    console.log(`Библиотека загружена с GitHub: ${library.videos.length} видео, ${Object.keys(library.playlists).length} плейлистов`);
  } catch (e) {
    console.error('Не удалось загрузить library.json с GitHub:', e.message);
  }
}

/** Сохраняет текущую библиотеку в память И коммитит на GitHub. */
async function saveLibrary() {
  try {
    const content = Buffer.from(JSON.stringify(library, null, 2), 'utf8').toString('base64');
    const body = {
      message: `Update library: ${library.videos.length} videos, ${Object.keys(library.playlists).length} playlists`,
      content,
      branch: GH_BRANCH,
      ...(librarySha ? { sha: librarySha } : {}),
    };

    const res = await fetch(GH_API, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Не удалось сохранить library.json на GitHub (${res.status}):`, errText.slice(0, 300));
      return false;
    }

    const data = await res.json();
    librarySha = data.content.sha; // следующий PUT должен ссылаться на новый sha
    return true;
  } catch (e) {
    console.error('Ошибка при сохранении library.json на GitHub:', e.message);
    return false;
  }
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
  res.json(library);
});

app.post('/api/playlists', async (req, res) => {
  const playlists = req.body;
  if (playlists === null || typeof playlists !== 'object' || Array.isArray(playlists)) {
    return res.status(400).json({ ok: false, error: 'expected object' });
  }
  library.playlists = playlists;
  const saved = await saveLibrary();
  res.json({ ok: true, persisted: saved });
});

app.post('/api/ingest', async (req, res) => {
  const key = req.header('x-ingest-key');
  if (!INGEST_KEY || key !== INGEST_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body;
  if (!Array.isArray(body.videos)) {
    return res.status(400).json({ ok: false, error: 'videos must be an array' });
  }

  library.videos = body.videos;
  if (body.playlists && typeof body.playlists === 'object' && !Array.isArray(body.playlists)) {
    library.playlists = body.playlists;
  }

  const saved = await saveLibrary();
  res.json({ ok: true, count: body.videos.length, persisted: saved });
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

// Библиотека грузится с GitHub ДО того, как сервис начнёт принимать трафик —
// иначе первые запросы после рестарта получат пустой список.
loadLibraryFromGitHub().then(() => {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
});
