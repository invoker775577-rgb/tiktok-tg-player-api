const express = require('express');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore, mergeIngest, deleteVideo, restoreVideo } = require('./library-store');
const { authorized } = require('./auth');
const { prepareVideo } = require('./media');
const VERSION = '2026.09.08.1';
const BOT_TOKEN = process.env.BOT_TOKEN, INGEST_KEY = process.env.INGEST_KEY, GH_TOKEN = process.env.GITHUB_TOKEN, CHAT_ID = process.env.CHAT_ID;
const OWNER_IDS = (process.env.OWNER_IDS || CHAT_ID || '').split(',').map((id) => id.trim());
const GH_BRANCH = process.env.GITHUB_BRANCH || 'master';
const GH_API = process.env.GITHUB_CONTENTS_URL || `https://api.github.com/repos/${process.env.GITHUB_REPO || 'invoker775577-rgb/tiktok-tg-player'}/contents/${process.env.GITHUB_LIBRARY_PATH || 'api-render/library.json'}`;
const TG_API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
const MAX_UPLOAD = 512 * 1024 * 1024;
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-ingest-key, x-telegram-init-data, range', 'access-control-expose-headers': 'content-length, content-range, accept-ranges', 'x-content-type-options': 'nosniff' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '4mb' }));
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const error = (status, message) => Object.assign(new Error(message), { status });
const ghHeaders = () => ({ Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' });
const store = createStore({
  async read() {
    const response = await fetch(`${GH_API}?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: ghHeaders(), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw error(503, `Хранилище временно недоступно (${response.status})`);
    const file = await response.json();
    return { data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), sha: file.sha };
  },
  async write(data, sha) {
    const response = await fetch(GH_API, { method: 'PUT', headers: ghHeaders(), signal: AbortSignal.timeout(20000), body: JSON.stringify({ message: `Update library: ${data.videos.length} videos [skip ci]`, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch: GH_BRANCH, sha }) });
    if (!response.ok) throw error(response.status === 409 ? 409 : 503, 'Не удалось сохранить изменения. Повторите попытку.');
  },
});
function auth(req, res, next) {
  if (authorized(req.headers, { botToken: BOT_TOKEN, ingestKey: INGEST_KEY, ownerIds: OWNER_IDS })) return next();
  res.status(401).json({ ok: false, error: 'Откройте плеер из своего Telegram или введите ключ доступа' });
}
function ready(req, res, next) { return store.value ? next() : res.status(503).json({ error: 'Библиотека загружается' }); }
const safeName = (name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 240 && !/[\x00-\x1f/\\]/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
function validPlaylists(value) { return value && !Array.isArray(value) && typeof value === 'object' && Object.entries(value).every(([key, items]) => safeName(key) && Array.isArray(items) && items.length <= 20000 && items.every(safeName)); }
app.get('/healthz', (req, res) => res.status(store.value ? 200 : 503).json({ ok: !!store.value, version: VERSION }));
app.get('/api/library', ready, (req, res) => res.set('cache-control', 'private, no-cache').json({ videos: store.value.videos, playlists: store.value.playlists }));
app.get('/api/access', auth, (req, res) => res.json({ ok: true, upload: !!CHAT_ID, maxUploadBytes: MAX_UPLOAD }));
app.post('/api/playlists', auth, ready, route(async (req, res) => {
  if (!validPlaylists(req.body)) throw error(400, 'Некорректные плейлисты');
  await store.mutate((draft) => { draft.playlists = req.body; });
  res.json({ ok: true, persisted: true });
}));
app.post('/api/ingest', auth, ready, route(async (req, res) => {
  if (!Array.isArray(req.body?.videos) || !req.body.videos.every((v) => safeName(v.name) && validId(v.file_id) && Number.isFinite(v.size) && v.size > 0) || (req.body.playlists && !validPlaylists(req.body.playlists))) throw error(400, 'Некорректная библиотека');
  await store.mutate((draft) => mergeIngest(draft, req.body));
  res.json({ ok: true, count: store.value.videos.length, persisted: true });
}));
app.post('/api/playlists/:name', auth, ready, route(async (req, res) => {
  if (!safeName(req.params.name)) throw error(400, 'Некорректное название');
  await store.mutate((draft) => {
    if (Object.hasOwn(draft.playlists, req.params.name)) throw error(409, 'Такой плейлист уже существует');
    draft.playlists[req.params.name] = [];
  });
  res.json({ ok: true, persisted: true, playlists: store.value.playlists });
}));
app.post('/api/playlists/:name/items', auth, ready, route(async (req, res) => {
  if (!safeName(req.params.name) || !safeName(req.body?.name) || typeof req.body.present !== 'boolean') throw error(400, 'Некорректные данные');
  await store.mutate((draft) => {
    const items = draft.playlists[req.params.name];
    if (!Array.isArray(items) || !draft.videos.some((v) => v.name === req.body.name)) throw error(404, 'Плейлист или видео не найдено');
    draft.playlists[req.params.name] = items.filter((name) => name !== req.body.name);
    if (req.body.present) draft.playlists[req.params.name].unshift(req.body.name);
  });
  res.json({ ok: true, persisted: true, playlists: store.value.playlists });
}));
app.delete('/api/videos/:name', auth, ready, route(async (req, res) => {
  if (!safeName(req.params.name)) throw error(400, 'Некорректное имя');
  await store.mutate((draft) => deleteVideo(draft, req.params.name));
  res.json({ ok: true, persisted: true });
}));
app.post('/api/videos/:name/restore', auth, ready, route(async (req, res) => {
  if (!safeName(req.params.name)) throw error(400, 'Некорректное имя');
  await store.mutate((draft) => restoreVideo(draft, req.params.name));
  res.json({ ok: true, persisted: true });
}));
const filePaths = new Map(), resolving = new Map();
async function resolveFile(fileId) {
  const cached = filePaths.get(fileId);
  if (cached?.expires > Date.now()) return cached.path;
  if (resolving.has(fileId)) return resolving.get(fileId);
  const operation = (async () => {
    const response = await fetch(`${TG_API}/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!data.ok || !data.result?.file_path) throw error(data.description?.includes('too big') ? 422 : response.status === 429 ? 503 : 404, data.description?.includes('too big') ? 'Этот старый файл превышает лимит Telegram. Загрузите его повторно.' : 'Видео временно недоступно');
    if (filePaths.size >= 2048) filePaths.delete(filePaths.keys().next().value);
    filePaths.set(fileId, { path: data.result.file_path, expires: Date.now() + 1800000 });
    return data.result.file_path;
  })();
  resolving.set(fileId, operation);
  try { return await operation; } finally { resolving.delete(fileId); }
}
app.get('/api/video/:fileId', ready, route(async (req, res) => {
  const id = req.params.fileId;
  if (!validId(id)) throw error(400, 'Некорректный файл');
  if (!store.value.videos.some((v) => v.file_id === id)) throw error(404, 'Видео не найдено');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);
  res.on('close', () => controller.abort());
  try {
    let upstream;
    for (let attempt = 0; attempt < 2; attempt++) {
      const filePath = await resolveFile(id);
      upstream = await fetch(`${TG_API}/file/bot${BOT_TOKEN}/${filePath}`, { headers: req.headers.range ? { range: req.headers.range } : {}, signal: controller.signal });
      if (![404, 410].includes(upstream.status)) break;
      await upstream.body?.cancel();
      filePaths.delete(id);
    }
    if (upstream.status === 416) {
      if (upstream.headers.has('content-range')) res.set('content-range', upstream.headers.get('content-range'));
      await upstream.body?.cancel();
      return res.sendStatus(416);
    }
    if (!upstream.ok) { await upstream.body?.cancel(); throw error(502, 'Хранилище видео временно недоступно'); }
    res.status(upstream.status).set({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' });
    for (const h of ['content-length', 'content-range']) if (upstream.headers.has(h)) res.set(h, upstream.headers.get(h));
    // Some Telegram download nodes ignore Range. Slice their stream without buffering it in memory.
    const total = Number(upstream.headers.get('content-length'));
    if (req.headers.range && upstream.status === 200 && total > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, total - Number(match?.[2]));
      const end = match?.[1] && match?.[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
      if (!match || (!match[1] && !match[2]) || start > end || start >= total) { await upstream.body.cancel(); res.removeHeader('content-length'); return res.status(416).set('content-range', `bytes */${total}`).end(); }
      res.status(206).set({ 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) });
      if (req.method === 'HEAD') { await upstream.body.cancel(); return res.end(); }
      let offset = 0;
      const reader = upstream.body.getReader();
      const selected = async function* () {
        try {
          while (offset <= end) {
            const { done, value } = await reader.read();
            if (done) break;
            const from = Math.max(0, start - offset), to = Math.min(value.length, end + 1 - offset);
            offset += value.length;
            if (to > from) yield value.subarray(from, to);
          }
        } finally { await reader.cancel().catch(() => {}); }
      };
      await pipeline(Readable.from(selected()), res);
    } else if (req.method === 'HEAD') { await upstream.body.cancel(); res.end(); }
    else await pipeline(Readable.fromWeb(upstream.body), res);
  } finally { clearTimeout(timeout); controller.abort(); }
}));
const jobs = new Map();
let activeJob = null;
const jobView = ({ id, name, status, progress, message, video }) => ({ id, name, status, progress, message, video });
app.post('/api/uploads', auth, ready, route(async (req, res) => {
  if (!CHAT_ID) throw error(503, 'Загрузка пока не настроена');
  if (activeJob) throw error(429, 'Сейчас обрабатывается другой файл. Повторите через минуту.');
  const name = String(req.query.name || '').normalize('NFC');
  const playlist = String(req.query.playlist || '');
  if (!safeName(name)) throw error(400, 'Некорректное имя файла');
  if (Number(req.headers['content-length']) > MAX_UPLOAD) throw error(413, 'Максимальный размер — 512 МБ');
  const job = { id: randomUUID(), name, status: 'uploading', progress: 0, controller: new AbortController() };
  activeJob = job.id;
  jobs.set(job.id, job);
  let directory;
  try {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tiktok-upload-'));
    const input = path.join(directory, 'input'), output = path.join(directory, 'video.mp4');
    let received = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(received > MAX_UPLOAD ? error(413, 'Максимальный размер — 512 МБ') : null, chunk); } });
    await pipeline(req, limit, fs.createWriteStream(input));
    if (!received) throw error(400, 'Файл пуст');
    job.status = 'processing';
    res.status(202).json(jobView(job));
    void (async () => {
      try {
        const info = await prepareVideo(input, output, { signal: job.controller.signal, progress: (value) => { job.progress = value; } });
        job.status = 'sending';
        const form = new FormData();
        form.set('chat_id', CHAT_ID);
        form.set('disable_notification', 'true');
        form.set('supports_streaming', 'true');
        form.set('caption', name);
        form.set('video', await fs.openAsBlob(output, { type: 'video/mp4' }), name.replace(/\.[^.]+$/, '') + '.mp4');
        const response = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendVideo`, { method: 'POST', body: form, signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(300000)]) });
        const data = await response.json();
        if (!data.ok || !data.result?.video) throw error(502, 'Telegram не принял видео. Повторите загрузку.');
        job.status = 'saving';
        const video = { name, file_id: data.result.video.file_id, ...info, mtime: Math.floor(Date.now() / 1000) };
        await store.mutate((draft) => {
          if (Object.hasOwn(draft.deleted, name)) throw error(409, 'Файл с этим именем удалён. Переименуйте его перед загрузкой.');
          mergeIngest(draft, { videos: [video] });
          if (safeName(playlist) && Object.hasOwn(draft.playlists, playlist) && !draft.playlists[playlist].includes(name)) draft.playlists[playlist].unshift(name);
        });
        job.video = video;
        job.progress = 100;
        job.status = 'done';
      } catch (failure) {
        job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
        job.message = failure.status ? failure.message : 'Не удалось обработать видео. Проверьте файл и повторите.';
      } finally {
        await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
        activeJob = null;
        setTimeout(() => jobs.delete(job.id), 3600000).unref();
      }
    })();
  } catch (failure) {
    activeJob = null;
    jobs.delete(job.id);
    if (directory) await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw failure;
  }
}));
app.get('/api/uploads/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  return job ? res.json(jobView(job)) : res.status(404).json({ error: 'Задание не найдено; сервер мог перезапуститься. Обновите библиотеку перед повтором.' });
});
app.delete('/api/uploads/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (job && ['processing', 'sending'].includes(job.status)) job.controller.abort();
  res.json({ ok: true });
});
app.use((failure, req, res, next) => {
  if (res.headersSent) return res.destroy();
  res.status(failure.status || 502).json({ ok: false, error: failure.status ? failure.message : 'Сервис временно недоступен. Повторите попытку.' });
});
async function start() {
  if (!BOT_TOKEN || !GH_TOKEN || !INGEST_KEY) throw new Error('BOT_TOKEN, GITHUB_TOKEN and INGEST_KEY are required');
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await store.load(); break; } catch (failure) {
      if (attempt === 5) throw failure;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  return app.listen(process.env.PORT || 3000, () => console.log(`Player API ${VERSION} ready`));
}
if (require.main === module) start().catch(() => { console.error('Startup failed: persistent library unavailable or configuration missing'); process.exit(1); });
module.exports = { app, start, store, resolveFile };
