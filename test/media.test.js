const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareVideo } = require('../media');

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
const ffprobe = process.env.FFPROBE_PATH || require('ffprobe-static').path;

test('compatible high-bitrate MP4 is recompressed for mobile playback', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tiktok-player-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.mp4');
  const output = path.join(directory, 'output.mp4');
  await exec(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '3000000', '-maxrate', '3000000', '-bufsize', '6000000',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', input,
  ], { windowsHide: true });

  const source = await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'json', input], { windowsHide: true });
  assert.ok(Number(JSON.parse(source.stdout).format.bit_rate) > 1_900_000);
  const result = await prepareVideo(input, output);
  const encoded = await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'json', output], { windowsHide: true });
  const outputBitrate = Number(JSON.parse(encoded.stdout).format.bit_rate);
  assert.ok(outputBitrate <= 2_100_000, `output bitrate was ${outputBitrate}`);
  assert.ok(result.size < (await stat(input)).size);
});
