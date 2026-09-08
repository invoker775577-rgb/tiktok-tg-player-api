const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createStore, mergeIngest, deleteVideo, restoreVideo } = require('../library-store');
const { authorized } = require('../auth');
const initial = () => ({ videos: [{ name: 'one.mp4', file_id: 'one', size: 100 }], playlists: { favorites: ['one.mp4'] }, deleted: {} });
test('failed persistence cannot mutate visible data', async () => {
  const store = createStore({ read: async () => ({ data: initial(), sha: '1' }), write: async () => { throw new Error('offline'); } });
  await store.load(); await assert.rejects(store.mutate((draft) => deleteVideo(draft, 'one.mp4')));
  assert.equal(store.value.videos.length, 1); assert.deepEqual(store.value.playlists.favorites, ['one.mp4']);
});
test('concurrent writes serialize; conflicts reread and preserve external changes', async () => {
  let data = initial(), sha = 1, conflict = true;
  const store = createStore({ read: async () => ({ data: structuredClone(data), sha }), write: async (next) => {
    if (conflict) { conflict = false; data.playlists.external = []; sha++; throw Object.assign(new Error(), { status: 409 }); }
    data = next; sha++;
  } });
  await store.load();
  await Promise.all([store.mutate((draft) => { draft.playlists.a = []; }), store.mutate((draft) => { draft.playlists.b = []; })]);
  assert.deepEqual(Object.keys(store.value.playlists).sort(), ['a', 'b', 'external', 'favorites']);
});
test('delete is durable across desktop ingest; undo restores playlist membership', () => {
  const data = initial(); deleteVideo(data, 'one.mp4');
  mergeIngest(data, { ...initial(), videos: [...initial().videos, { name: 'two.mp4', file_id: 'two', size: 2 }] });
  assert.deepEqual(data.videos.map((v) => v.name), ['two.mp4']); assert.deepEqual(data.playlists.favorites, []);
  restoreVideo(data, 'one.mp4'); restoreVideo(data, 'one.mp4');
  assert.equal(data.videos.length, 2); assert.deepEqual(data.playlists.favorites, ['one.mp4']);
});
test('auth requires signed fresh Telegram owner data or correct key', () => {
  const now = Date.now(), botToken = '123:token';
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 123 }) });
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update([...params].sort().map(([k,v]) => `${k}=${v}`).join('\n')).digest('hex');
  params.set('hash', hash);
  const config = { botToken, ingestKey: 'secret', ownerIds: ['123'], now };
  assert.equal(authorized({ 'x-telegram-init-data': params.toString() }, config), true);
  assert.equal(authorized({ 'x-telegram-init-data': params.toString() }, { ...config, ownerIds: ['456'] }), false);
  assert.equal(authorized({ 'x-telegram-init-data': params.toString() }, { ...config, now: now + 90000000 }), false);
  params.set('user', '{"id":456}');
  assert.equal(authorized({ 'x-telegram-init-data': params.toString() }, config), false);
  assert.equal(authorized({ 'x-ingest-key': 'secret' }, config), true);
  assert.equal(authorized({}, config), false);
});
