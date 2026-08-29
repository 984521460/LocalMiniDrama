'use strict';

const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const { createAssetVersionEvidence } = require('../assets/assetVersionEvidence');
const {
  canonicalUid,
  epoch,
  exactObject,
  fail,
} = require('../audio/audioContract');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const {
  MAX_LOCAL_MEDIA_BYTES,
  createMediaProbeEvidence,
  createMediaProbeEvidenceVerifier,
} = require('./mediaProbeEvidence');
const {
  executeBoundedMediaProcess,
  runBoundedMediaProcess,
} = require('./boundedMediaProcess');
const { parseFfprobeEvidence } = require('./ffprobeEvidenceParser');
const {
  assertLocalMediaFileUnchanged,
  hashLocalMediaFile,
  resolveStableLocalMediaFile,
} = require('./localMediaFile');

const INPUT_CODE = 'MEDIA_PROBE_INPUT_INVALID';
const FAILED_CODE = 'MEDIA_PROBE_FAILED';
const DEFAULT_TIMEOUT_MS = 60_000;
const CONFIG_REQUIRED_KEYS = Object.freeze(['localRoot']);
const CONFIG_OPTIONAL_KEYS = Object.freeze([
  'ffprobePath', 'ffmpegPath', 'runProcess', 'timeoutMs', 'maxFileBytes',
]);
const INSPECT_KEYS = Object.freeze(['schemaVersion', 'uid', 'assetVersion', 'probedAtEpochMs']);

function invalid(code = FAILED_CODE) {
  fail(code);
}

function exactConfiguration(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
      invalid(INPUT_CODE);
    }
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(INPUT_CODE);
    const allowed = new Set([...CONFIG_REQUIRED_KEYS, ...CONFIG_OPTIONAL_KEYS]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))
      || CONFIG_REQUIRED_KEYS.some((key) => !Object.hasOwn(descriptors, key))) invalid(INPUT_CODE);
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(INPUT_CODE);
      output[key] = descriptor.value;
    }
    const timeoutMs = output.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxFileBytes = output.maxFileBytes ?? MAX_LOCAL_MEDIA_BYTES;
    const runProcess = output.runProcess ?? runBoundedMediaProcess;
    const ffprobePath = output.ffprobePath ?? getFfprobePath();
    const ffmpegPath = output.ffmpegPath ?? getFfmpegPath();
    if (typeof output.localRoot !== 'string' || !path.isAbsolute(output.localRoot)
      || output.localRoot.includes('\0')
      || typeof ffprobePath !== 'string' || ffprobePath.length < 1 || ffprobePath.includes('\0')
      || typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.includes('\0')
      || typeof runProcess !== 'function' || isProxy(runProcess)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000
      || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
      || maxFileBytes > MAX_LOCAL_MEDIA_BYTES) invalid(INPUT_CODE);
    return Object.freeze({
      localRoot: path.resolve(output.localRoot),
      ffprobePath,
      ffmpegPath,
      runProcess,
      timeoutMs,
      maxFileBytes,
    });
  } catch {
    return invalid(INPUT_CODE);
  }
}

function inspectInput(value) {
  try {
    const input = exactObject(value, INSPECT_KEYS, INPUT_CODE);
    if (input.schemaVersion !== '8.0') invalid(INPUT_CODE);
    let version;
    try { version = createAssetVersionEvidence(input.assetVersion); } catch { return invalid(INPUT_CODE); }
    const video = version.mimeType === 'video/mp4';
    const audio = ['audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav']
      .includes(version.mimeType);
    if (version.storageProvider !== 'local' || version.sha256 === null
      || version.durationMs === null || version.durationMs < 1 || (!video && !audio)
      || (video && (version.width === null || version.height === null))
      || (audio && (version.width !== null || version.height !== null))) invalid(INPUT_CODE);
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const probedAtEpochMs = epoch(input.probedAtEpochMs, INPUT_CODE);
    if (probedAtEpochMs < Date.parse(version.createdAt)) invalid(INPUT_CODE);
    return Object.freeze({
      schemaVersion: '8.0',
      uid,
      assetVersion: version,
      probedAtEpochMs,
    });
  } catch {
    return invalid(INPUT_CODE);
  }
}

function trustedEvidence(envelope) {
  const candidate = createMediaProbeEvidence(envelope);
  const verifier = createMediaProbeEvidenceVerifier({
    loadTrustedEnvelope(expectedUid) {
      if (expectedUid !== envelope.uid) invalid();
      return envelope;
    },
  });
  return verifier.verify(candidate, envelope.uid);
}

function createLocalMediaProbe(value) {
  const config = exactConfiguration(value);
  return Object.freeze({
    async inspect(valueToInspect) {
      try {
        const input = inspectInput(valueToInspect);
        const resolved = await resolveStableLocalMediaFile(
          config, input.assetVersion.relativePath,
        );
        const initialHash = await hashLocalMediaFile(resolved.real, config.maxFileBytes);
        if (initialHash.sha256 !== input.assetVersion.sha256) invalid();
        const probeResult = await executeBoundedMediaProcess(config, config.ffprobePath, [
          '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
          '-count_frames', resolved.real,
        ]);
        const measurements = parseFfprobeEvidence(
          probeResult.stdout, input.assetVersion.mimeType,
        );
        const decodeMaps = input.assetVersion.mimeType === 'video/mp4'
          ? ['-map', '0:v:0', '-map', '0:a:0?']
          : ['-map', '0:a:0'];
        await executeBoundedMediaProcess(config, config.ffmpegPath, [
          '-v', 'error', '-xerror', '-nostdin', '-i', resolved.real,
          ...decodeMaps, '-f', 'null', '-',
        ]);
        await assertLocalMediaFileUnchanged(config, resolved, initialHash);
        return trustedEvidence(Object.freeze({
          schemaVersion: '8.0',
          uid: input.uid,
          assetVersion: input.assetVersion,
          bytes: initialHash.bytes,
          durationMs: measurements.durationMs,
          formatNames: measurements.formatNames,
          video: measurements.video,
          audio: measurements.audio,
          decoded: true,
          probedAtEpochMs: input.probedAtEpochMs,
        }));
      } catch {
        return invalid();
      }
    },
  });
}

module.exports = Object.freeze({ createLocalMediaProbe });
