'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { types: { isPromise, isProxy } } = require('node:util');

const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { exactKeys, sha256, snapshot } = require('./contract');
const { fail } = require('./errors');

const CODE = 'H3_OUTPUT_INVALID';
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const INSPECTORS = new WeakSet();

function invalid() {
  fail(CODE);
}

function exactConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = ['localRoot'];
  const optional = ['ffprobePath', 'ffmpegPath', 'runProcess', 'timeoutMs'];
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))) invalid();
  const output = Object.create(null);
  for (const key of [...required, ...optional]) {
    if (!Object.hasOwn(descriptors, key)) continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = descriptor.value;
  }
  const localRoot = output.localRoot;
  const timeoutMs = output.timeoutMs ?? 60_000;
  const runProcess = output.runProcess ?? runBoundedProcess;
  const ffprobePath = output.ffprobePath ?? getFfprobePath();
  const ffmpegPath = output.ffmpegPath ?? getFfmpegPath();
  if (typeof localRoot !== 'string' || !path.isAbsolute(localRoot)
    || typeof ffprobePath !== 'string' || ffprobePath.length < 1 || ffprobePath.includes('\0')
    || typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.includes('\0')
    || typeof runProcess !== 'function' || isProxy(runProcess)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) invalid();
  return Object.freeze({
    localRoot: path.resolve(localRoot),
    ffprobePath,
    ffmpegPath,
    runProcess,
    timeoutMs,
  });
}

function runBoundedProcess(command, args, { timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const append = (target, chunk, currentBytes) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (currentBytes + bytes.length > maxOutputBytes) {
        try { child.kill(); } catch { /* fixed failure below */ }
        finish(reject, new Error('bounded process output exceeded'));
        return null;
      }
      target.push(bytes);
      return currentBytes + bytes.length;
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* fixed timeout below */ }
      finish(reject, new Error('bounded process timeout'));
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        const next = append(stdout, chunk, stdoutBytes);
        if (next !== null) stdoutBytes = next;
      });
      child.stderr.on('data', (chunk) => {
        const next = append(stderr, chunk, stderrBytes);
        if (next !== null) stderrBytes = next;
      });
      child.once('error', (error) => finish(reject, error));
      child.once('close', (exitCode) => finish(resolve, {
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    } catch (error) {
      finish(reject, error);
    }
  });
}

function boundedResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 3
    || !['exitCode', 'stdout', 'stderr'].every((key) => (
      descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value')
    ))) invalid();
  const result = Object.fromEntries(
    ['exitCode', 'stdout', 'stderr'].map((key) => [key, descriptors[key].value]),
  );
  if (!Number.isSafeInteger(result.exitCode)
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || Buffer.byteLength(result.stdout, 'utf8') > MAX_PROCESS_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) invalid();
  return result;
}

async function settleProcess(configured, command, args) {
  let timeout;
  try {
    const operation = configured.runProcess(command, Object.freeze([...args]), Object.freeze({
      timeoutMs: configured.timeoutMs,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    }));
    if (!isPromise(operation) || isProxy(operation)
      || Object.getPrototypeOf(operation) !== Promise.prototype
      || Object.hasOwn(operation, 'then') || Object.hasOwn(operation, 'constructor')) invalid();
    const result = await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('probe timeout')), configured.timeoutMs);
      }),
    ]);
    return boundedResult(result);
  } catch {
    return invalid();
  } finally {
    clearTimeout(timeout);
  }
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || value !== value.trim() || value.includes('\0') || value.includes('\\')
    || value.startsWith('/') || value.endsWith('/')) invalid();
  const segments = value.split('/');
  if (segments.some((segment) => segment.length < 1 || segment === '.' || segment === '..'
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(segment))) invalid();
  return segments;
}

async function resolveLocalFile(localRoot, relativePath) {
  const rootStats = await fs.promises.lstat(localRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) invalid();
  const rootReal = await fs.promises.realpath(localRoot);
  const candidate = path.resolve(rootReal, ...safeRelativePath(relativePath));
  if (!candidate.startsWith(`${rootReal}${path.sep}`)) invalid();
  const stats = await fs.promises.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) invalid();
  const real = await fs.promises.realpath(candidate);
  if (!real.startsWith(`${rootReal}${path.sep}`)) invalid();
  return Object.freeze({ real, bytes: stats.size });
}

function expectedMedia(value) {
  const expected = snapshot(value, CODE);
  exactKeys(expected, ['width', 'height', 'durationMs', 'frames', 'fps'], CODE);
  if (![expected.width, expected.height, expected.durationMs, expected.frames, expected.fps]
    .every(Number.isSafeInteger)
    || expected.width < 1 || expected.height < 1 || expected.durationMs < 1
    || expected.frames < 1 || expected.fps < 1 || expected.fps > 120) invalid();
  return expected;
}

function fraction(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\/\d{1,6}$/u.test(value)) invalid();
  const [numerator, denominator] = value.split('/').map(Number);
  if (denominator === 0) invalid();
  return numerator / denominator;
}

function decimalMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,9})?$/u.test(value)) invalid();
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) invalid();
  return Math.round(seconds * 1000);
}

function parseProbe(stdout, expected) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Array.isArray(parsed.streams) || !parsed.format || typeof parsed.format !== 'object') invalid();
  const videos = parsed.streams.filter((stream) => stream?.codec_type === 'video');
  const audios = parsed.streams.filter((stream) => stream?.codec_type === 'audio');
  if (videos.length !== 1 || audios.length !== 1) invalid();
  const video = videos[0];
  const audio = audios[0];
  const frames = Number(video.nb_read_frames ?? video.nb_frames);
  const fps = fraction(video.avg_frame_rate);
  const durationMs = decimalMilliseconds(video.duration ?? parsed.format.duration);
  if (!Number.isSafeInteger(video.width) || video.width !== expected.width
    || !Number.isSafeInteger(video.height) || video.height !== expected.height
    || !Number.isSafeInteger(frames) || frames !== expected.frames
    || fps !== expected.fps
    || Math.abs(durationMs - expected.durationMs) > 300
    || video.codec_name !== 'h264' || audio.codec_name !== 'aac'
    || typeof parsed.format.format_name !== 'string'
    || !parsed.format.format_name.split(',').includes('mp4')) invalid();
  return Object.freeze({ durationMs, frames, fps, videoCodec: 'h264', audioCodec: 'aac' });
}

function eventRatio(stderr, label, durationMs) {
  const pattern = new RegExp(`${label}:(\\d+(?:\\.\\d+)?)`, 'gu');
  let totalSeconds = 0;
  for (const match of stderr.matchAll(pattern)) totalSeconds += Number(match[1]);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) invalid();
  return Math.min(1, totalSeconds / (durationMs / 1000));
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return Object.freeze({ sha256: hash.digest('hex'), bytes });
}

function createH3LocalVideoInspector(options) {
  const configured = exactConfiguration(options);
  const inspector = Object.freeze({
    async inspect(value) {
      try {
        const input = snapshot(value, CODE);
        exactKeys(input, ['localRelativePath', 'expected', 'remoteSha256', 'remoteBytes'], CODE);
        sha256(input.remoteSha256, CODE);
        if (!Number.isSafeInteger(input.remoteBytes) || input.remoteBytes < 1
          || input.remoteBytes > 20_000_000_000) invalid();
        const expected = expectedMedia(input.expected);
        const local = await resolveLocalFile(configured.localRoot, input.localRelativePath);
        const localHash = await hashFile(local.real);
        if (local.bytes !== input.remoteBytes || localHash.bytes !== input.remoteBytes
          || localHash.sha256 !== input.remoteSha256) invalid();
        const probe = await settleProcess(configured, configured.ffprobePath, [
          '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', local.real,
        ]);
        if (probe.exitCode !== 0) invalid();
        const metadata = parseProbe(probe.stdout, expected);
        const analysis = await settleProcess(configured, configured.ffmpegPath, [
          '-hide_banner', '-nostdin', '-v', 'info', '-i', local.real,
          '-map', '0:v:0', '-vf', 'blackdetect=d=0.05:pic_th=0.98,freezedetect=n=-50dB:d=0.10',
          '-an', '-f', 'null', '-',
        ]);
        if (analysis.exitCode !== 0) invalid();
        const blackFrameRatio = eventRatio(analysis.stderr, 'black_duration', metadata.durationMs);
        const frozenFrameRatio = eventRatio(analysis.stderr, 'freeze_duration', metadata.durationMs);
        if (blackFrameRatio > 0.95 || frozenFrameRatio > 0.95) invalid();
        return Object.freeze({
          sha256: localHash.sha256,
          bytes: localHash.bytes,
          mimeType: 'video/mp4',
          width: expected.width,
          height: expected.height,
          durationMs: metadata.durationMs,
          frames: metadata.frames,
          fps: metadata.fps,
          videoCodec: metadata.videoCodec,
          audioCodec: metadata.audioCodec,
          audioStreams: 1,
          blackFrameRatio,
          frozenFrameRatio,
        });
      } catch {
        return invalid();
      }
    },
  });
  INSPECTORS.add(inspector);
  return inspector;
}

function isH3LocalVideoInspector(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && INSPECTORS.has(value);
}

module.exports = Object.freeze({ createH3LocalVideoInspector, isH3LocalVideoInspector });
