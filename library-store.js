const clone = (value) => structuredClone(value);

function normalize(data) {
  if (!data || !Array.isArray(data.videos) || !data.playlists || typeof data.playlists !== 'object' || Array.isArray(data.playlists)) {
    throw new Error('Invalid library; refusing to replace existing data');
  }
  return { videos: data.videos, playlists: data.playlists, deleted: data.deleted || {} };
}

// Every write is serialized, re-reads the persistent source, and retries conflicts.
// Failed writes never change the visible library or report success.
function createStore({ read, write }) {
  let value;
  let pending = Promise.resolve();
  return {
    get value() { return value; },
    async load() { value = normalize((await read()).data); return value; },
    mutate(change) {
      const operation = pending.then(async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const latest = await read();
          const draft = normalize(clone(latest.data));
          const result = change(draft);
          try {
            await write(draft, latest.sha);
            value = draft;
            return result;
          } catch (error) {
            if (error.status !== 409 || attempt === 3) throw error;
          }
        }
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}

function mergeIngest(library, incoming) {
  const videos = new Map(library.videos.map((video) => [video.name, video]));
  for (const video of incoming.videos) {
    if (!Object.hasOwn(library.deleted, video.name)) videos.set(video.name, video);
  }
  library.videos = [...videos.values()].sort((a, b) => b.name.localeCompare(a.name));
  // Existing server playlists are authoritative; a desktop upload cannot erase edits.
  for (const [name, items] of Object.entries(incoming.playlists || {})) {
    if (!Object.hasOwn(library.playlists, name)) library.playlists[name] = items.filter((item) => videos.has(item));
  }
}

function deleteVideo(library, name) {
  const video = library.videos.find((item) => item.name === name);
  if (!video) return;
  const playlists = Object.entries(library.playlists).filter(([, items]) => items.includes(name)).map(([key]) => key);
  library.deleted[name] = { video, playlists, deletedAt: Date.now() };
  library.videos = library.videos.filter((item) => item.name !== name);
  for (const key of playlists) library.playlists[key] = library.playlists[key].filter((item) => item !== name);
}

function restoreVideo(library, name) {
  const record = library.deleted[name];
  if (!record) return;
  if (!library.videos.some((item) => item.name === name)) library.videos.unshift(record.video);
  for (const key of record.playlists) {
    if (Object.hasOwn(library.playlists, key) && !library.playlists[key].includes(name)) library.playlists[key].push(name);
  }
  delete library.deleted[name];
}

module.exports = { createStore, mergeIngest, deleteVideo, restoreVideo };
