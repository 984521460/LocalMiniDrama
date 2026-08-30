'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const { epoch, exactObject, fail } = require('../audio/audioContract');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { executeBoundedMediaProcess, runBoundedMediaProcess } = require('./boundedMediaProcess');
const { parseFfprobeEvidence } = require('./ffprobeEvidenceParser');
const { hashLocalMediaFile } = require('./localMediaFile');
const { createMediaExportReceipt } = require('./mediaExportReceipt');
const { requireTrustedMediaExportExecutionPlan } = require('./mediaExportExecutionPlan');
const { assertFastStartMp4 } = require('./mp4FastStart');

const INPUT_CODE = 'MEDIA_EXPORT_INPUT_INVALID';
const OUTPUT_CODE = 'MEDIA_EXPORT_OUTPUT_INVALID';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const REQUIRED_CONFIG_KEYS = Object.freeze([]);
const OPTIONAL_CONFIG_KEYS = Object.freeze([
  'ffprobePath', 'ffmpegPath', 'runProcess', 'timeoutMs', 'maxOutputBytes',
]);

function invalid(code = OUTPUT_CODE) {
  fail(code);
}

function configuration(value) {
  try {
    if (value === undefined) value = {};
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
      invalid(INPUT_CODE);
    }
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(INPUT_CODE);
    const allowed = new Set([...REQUIRED_CONFIG_KEYS, ...OPTIONAL_CONFIG_KEYS]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) invalid(INPUT_CODE);
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(INPUT_CODE);
      output[key] = descriptor.value;
    }
    const ffprobePath = output.ffprobePath ?? getFfprobePath();
    const ffmpegPath = output.ffmpegPath ?? getFfmpegPath();
    const runProcess = output.runProcess ?? runBoundedMediaProcess;
    const timeoutMs = output.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = output.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (typeof ffprobePath !== 'string' || ffprobePath.length < 1 || ffprobePath.includes('\0')
      || typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.includes('\0')
      || typeof runProcess !== 'function' || isProxy(runProcess)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 1_800_000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
      || maxOutputBytes > MAX_OUTPUT_BYTES) invalid(INPUT_CODE);
    return Object.freeze({ ffprobePath, ffmpegPath, runProcess, timeoutMs, maxOutputBytes });
  } catch {
    return invalid(INPUT_CODE);
  }
}

function createMediaExportOutputVerifier(value) {
  const config = configuration(value);
  return Object.freeze({
    async verify(inputValue) {
      try {
        const input = exactObject(
          inputValue, ['schemaVersion', 'executionPlan', 'candidatePath', 'completedAtEpochMs'],
          OUTPUT_CODE,
        );
        if (input.schemaVersion !== '8.0' || typeof input.candidatePath !== 'string'
          || !path.isAbsolute(input.candidatePath) || input.candidatePath.includes('\0')) invalid();
        const plan = requireTrustedMediaExportExecutionPlan(input.executionPlan);
        const completedAtEpochMs = epoch(input.completedAtEpochMs, OUTPUT_CODE);
        const before = await fs.promises.lstat(input.candidatePath);
        if (!before.isFile() || before.isSymbolicLink() || before.size < 1
          || before.size > config.maxOutputBytes) invalid();
        const initialHash = await hashLocalMediaFile(input.candidatePath, config.maxOutputBytes);
        const processConfig = Object.freeze({
          runProcess: config.runProcess,
          timeoutMs: config.timeoutMs,
          cwd: path.dirname(input.candidatePath),
        });
        const probe = await executeBoundedMediaProcess(processConfig, config.ffprobePath, [
          '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
          '-count_frames', input.candidatePath,
        ]);
        const measurements = parseFfprobeEvidence(probe.stdout, 'video/mp4');
        await executeBoundedMediaProcess(processConfig, config.ffmpegPath, [
          '-v', 'error', '-xerror', '-nostdin', '-i', input.candidatePath,
          '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
        ]);
        await assertFastStartMp4(input.candidatePath, config.maxOutputBytes);
        const after = await fs.promises.lstat(input.candidatePath);
        const finalHash = await hashLocalMediaFile(input.candidatePath, config.maxOutputBytes);
        if (!after.isFile() || after.isSymbolicLink()
          || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || initialHash.bytes !== finalHash.bytes || initialHash.sha256 !== finalHash.sha256) invalid();
        return createMediaExportReceipt({
          schemaVersion: '8.0',
          executionPlan: plan,
          output: {
            relativePath: plan.outputRelativePath,
            sha256: finalHash.sha256,
            bytes: finalHash.bytes,
            durationMs: measurements.durationMs,
            formatNames: measurements.formatNames,
            video: measurements.video,
            audio: measurements.audio,
            decoded: true,
            fastStart: true,
          },
          completedAtEpochMs,
        });
      } catch {
        return invalid();
      }
    },
  });
}

module.exports = Object.freeze({ createMediaExportOutputVerifier });
