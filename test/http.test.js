const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
test('HTTP ranges, authorization, durable delete, and a real >50 MB upload', { timeout: 120000 }, async () => {
  let data = { videos: [{ name: 'one.mp4', file_id: 'one', size: 10 }], playlists: { favorites: ['one.mp4'] } };
  let sentBytes = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.url.startsWith('/contents')) {
      if (req.method === 'PUT') { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); data = JSON.parse(Buffer.from(body.content, 'base64')); return res.end('{}'); }
      return res.end(JSON.stringify({ sha: 'sha', content: Buffer.from(JSON.stringify(data)).toString('base64') }));
    }
    if (req.url.includes('/getFile')) return res.end(JSON.stringify({ ok: true, result: { file_path: 'video.mp4' } }));
    if (req.url.includes('/sendVideo')) { sentBytes = 0; for await (const chunk of req) sentBytes += chunk.length; return res.end(JSON.stringify({ ok: true, result: { video: { file_id: 'uploaded' } } })); }
    res.setHeader('content-length', '10'); res.end('0123456789'); // Deliberately ignores Range.
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, { BOT_TOKEN: 'test', INGEST_KEY: 'key', GITHUB_TOKEN: 'test', CHAT_ID: '123', TELEGRAM_API_URL: base, GITHUB_CONTENTS_URL: base + '/contents' });
  const { app, store } = require('../server'); await store.load();
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'player-test-'));
  try {
    for (const [range, content, contentRange] of [['bytes=2-5','2345','bytes 2-5/10'], ['bytes=-3','789','bytes 7-9/10'], ['bytes=7-','789','bytes 7-9/10']]) {
      const response = await fetch(api + '/api/video/one', { headers: { range } });
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), contentRange); assert.equal(await response.text(), content);
    }
    const head = await fetch(api + '/api/video/one', { method: 'HEAD', headers: { range: 'bytes=0-1' } }); assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '2'); assert.equal(await head.text(), '');
    assert.equal((await fetch(api + '/api/video/one', { headers: { range: 'bytes=99-' } })).status, 416);
    assert.equal((await fetch(api + '/api/video/unknown')).status, 404);
    assert.equal((await fetch(api + '/api/videos/one.mp4', { method: 'DELETE' })).status, 401);
    const headers = { 'x-ingest-key': 'key' };
    assert.equal((await fetch(api + '/api/videos/one.mp4', { method: 'DELETE', headers })).status, 200);
    assert.equal(store.value.videos.length, 0);
    assert.equal((await fetch(api + '/api/videos/one.mp4/restore', { method: 'POST', headers })).status, 200);
    assert.deepEqual(store.value.playlists.favorites, ['one.mp4']);
    const file = path.join(directory, 'large.mp4');
    await exec(process.env.FFMPEG_PATH || require('ffmpeg-static'), ['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x240:rate=30','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',file], { windowsHide: true });
    // Valid MP4 with a large trailing free atom exercises the actual 60 MB HTTP body.
    const free = Buffer.alloc(60 * 1024 * 1024); free.writeUInt32BE(free.length, 0); free.write('free', 4); await fsp.appendFile(file, free);
    const response = await fetch(api + '/api/uploads?name=large.mp4&playlist=favorites', { method: 'POST', headers: { ...headers, 'content-type':'application/octet-stream' }, body: await fs.openAsBlob(file) });
    assert.equal(response.status, 202, await response.clone().text()); const job = await response.json();
    let result;
    for (let attempt = 0; attempt < 100; attempt++) { result = await (await fetch(api + '/api/uploads/' + job.id, { headers })).json(); if (['done','error'].includes(result.status)) break; await new Promise((resolve) => setTimeout(resolve, 300)); }
    assert.equal(result.status, 'done', JSON.stringify(result)); assert.ok(sentBytes > 1000 && sentBytes < 19_100_000);
    assert.ok(store.value.videos.find((v) => v.name === 'large.mp4').size < 19000000); assert.ok(store.value.playlists.favorites.includes('large.mp4'));
  } finally { server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]); await fsp.rm(directory, { recursive: true, force: true }); }
});
