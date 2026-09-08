const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
const ffprobe = process.env.FFPROBE_PATH || require('ffprobe-static').path;
const exec = promisify(execFile);
const MAX_MEDIA_BYTES = 19_000_000;

async function probe(file) {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  const data = JSON.parse(stdout);
  const video = data.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(data.format.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 7200) throw new Error('Нужен корректный видеофайл длительностью до 2 часов');
  return { video, audio: data.streams.find((s) => s.codec_type === 'audio'), duration };
}

function encode(args, { signal, progress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, signal });
    let report = '';
    child.stdout.on('data', (chunk) => {
      report = (report + chunk).slice(-4096);
      const matches = [...report.matchAll(/out_time_us=(\d+)/g)];
      if (matches.length) progress?.(Number(matches.at(-1)[1]) / 1000000);
    });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 1800000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Не удалось обработать видео')); });
  });
}

async function prepareVideo(input, output, options = {}) {
  const info = await probe(input);
  const size = (await fs.stat(input)).size;
  const compatible = info.video.codec_name === 'h264' && info.video.pix_fmt === 'yuv420p' && (!info.audio || info.audio.codec_name === 'aac');
  const common = ['-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  if (compatible && size < 18_500_000) {
    await encode([...common, '-c', 'copy', '-movflags', '+faststart', output], options);
  } else {
    let bitrate = Math.min(3500000, Math.floor(17_800_000 * 8 / info.duration) - 100000);
    if (bitrate < 40000) throw new Error('Слишком длинное видео. Разделите его на части.');
    for (let attempt = 0; attempt < 3; attempt++) {
      await encode([...common, '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30", '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p', '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2), '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-progress', 'pipe:1', output], { ...options, progress: (seconds) => options.progress?.(Math.min(98, Math.round(seconds / info.duration * 100))) });
      const actual = (await fs.stat(output)).size;
      if (actual <= MAX_MEDIA_BYTES) break;
      bitrate = Math.floor(bitrate * (17_500_000 / actual));
    }
  }
  const actual = (await fs.stat(output)).size;
  if (!actual || actual > MAX_MEDIA_BYTES) throw new Error('Не удалось уменьшить файл до лимита хранилища');
  const result = await probe(output);
  return { size: actual, duration: result.duration, width: result.video.width, height: result.video.height };
}
module.exports = { prepareVideo, probe, MAX_MEDIA_BYTES };
