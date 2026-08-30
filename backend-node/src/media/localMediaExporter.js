'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const {
  epoch,
  exactObject,
  fail,
  isAudioModeContractError,
} = require('../audio/audioContract');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { executeBoundedMediaProcess, runBoundedMediaProcess } = require('./boundedMediaProcess');
const { createFfmpegComposition } = require('./ffmpegComposition');
const {
  assertLocalMediaFileUnchanged,
  hashLocalMediaFile,
  resolveStableLocalMediaFile,
} = require('./localMediaFile');
const {
  assertMediaExportWorkspaceUnchanged,
  createMediaExportWorkspace,
  installMediaExportCandidate,
  rollbackMediaExportInstallation,
} = require('./localMediaExportWorkspace');
const {
  requireTrustedMediaExportExecutionPlan,
} = require('./mediaExportExecutionPlan');
const { createMediaExportOutputVerifier } = require('./mediaExportOutputVerifier');

const INPUT_CODE = 'MEDIA_EXPORT_INPUT_INVALID';
const FAILED_CODE = 'MEDIA_EXPORT_FAILED';
const OUTPUT_CODE = 'MEDIA_EXPORT_OUTPUT_INVALID';
const MAX_MEDIA_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const CONFIG_REQUIRED_KEYS = Object.freeze(['localRoot', 'workspaceRoot']);
const CONFIG_OPTIONAL_KEYS = Object.freeze([
  'ffmpegPath', 'ffprobePath', 'runProcess', 'timeoutMs', 'maxSourceBytes',
  'maxOutputBytes',
]);
const EXPORT_KEYS = Object.freeze([
  'schemaVersion', 'executionPlan', 'completedAtEpochMs',
]);

function invalid(code = FAILED_CODE) {
  fail(code);
}

function safeError(error) {
  if (isAudioModeContractError(error)
    && [INPUT_CODE, FAILED_CODE, OUTPUT_CODE].includes(error.code)) throw error;
  return invalid();
}

function configuration(value) {
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
    const ffmpegPath = output.ffmpegPath ?? getFfmpegPath();
    const ffprobePath = output.ffprobePath ?? getFfprobePath();
    const runProcess = output.runProcess ?? runBoundedMediaProcess;
    const timeoutMs = output.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxSourceBytes = output.maxSourceBytes ?? MAX_MEDIA_BYTES;
    const maxOutputBytes = output.maxOutputBytes ?? MAX_MEDIA_BYTES;
    if (typeof output.localRoot !== 'string' || !path.isAbsolute(output.localRoot)
      || output.localRoot.includes('\0')
      || typeof output.workspaceRoot !== 'string' || !path.isAbsolute(output.workspaceRoot)
      || output.workspaceRoot.includes('\0')
      || typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.includes('\0')
      || typeof ffprobePath !== 'string' || ffprobePath.length < 1 || ffprobePath.includes('\0')
      || typeof runProcess !== 'function' || isProxy(runProcess)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 1_800_000
      || !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1
      || maxSourceBytes > MAX_MEDIA_BYTES
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
      || maxOutputBytes > MAX_MEDIA_BYTES) invalid(INPUT_CODE);
    return Object.freeze({
      localRoot: path.resolve(output.localRoot),
      workspaceRoot: path.resolve(output.workspaceRoot),
      ffmpegPath,
      ffprobePath,
      runProcess,
      timeoutMs,
      maxSourceBytes,
      maxOutputBytes,
    });
  } catch (error) {
    return safeError(error);
  }
}

async function writeArtifact(workspacePath, fileName, content) {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(fileName) || typeof content !== 'string'
    || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) invalid();
  const target = path.join(workspacePath, fileName);
  await fs.promises.writeFile(target, content, { encoding: 'utf8', flag: 'wx', flush: true });
}

function allSources(plan) {
  const sources = [];
  const seen = new Map();
  for (const source of [...plan.videoSources, ...plan.audioSources]) {
    const existing = seen.get(source.assetVersionUid);
    if (existing) {
      if (existing.relativePath !== source.relativePath || existing.sha256 !== source.sha256) {
        invalid(INPUT_CODE);
      }
      continue;
    }
    seen.set(source.assetVersionUid, source);
    sources.push(source);
  }
  return sources;
}

async function resolveSources(config, plan) {
  const records = [];
  for (const source of allSources(plan)) {
    const resolved = await resolveStableLocalMediaFile(config, source.relativePath);
    const initialHash = await hashLocalMediaFile(resolved.real, config.maxSourceBytes);
    if (initialHash.sha256 !== source.sha256) invalid();
    records.push(Object.freeze({ source, resolved, initialHash }));
  }
  return Object.freeze(records);
}

function sourcePath(records, plan, ordinal, kind) {
  const source = kind === 'video'
    ? plan.videoSources[ordinal]
    : plan.audioSources.find((entry) => entry.ordinal === ordinal);
  const record = records.find((entry) => (
    entry.source.assetVersionUid === source?.assetVersionUid
  ));
  if (!record) invalid();
  return record.resolved.real;
}

async function assertSourcesUnchanged(config, records) {
  for (const record of records) {
    await assertLocalMediaFileUnchanged(config, record.resolved, record.initialHash);
  }
}

async function execute(config, workspacePath, args) {
  try {
    return await executeBoundedMediaProcess(Object.freeze({
      runProcess: config.runProcess,
      timeoutMs: config.timeoutMs,
      cwd: workspacePath,
    }), config.ffmpegPath, args);
  } catch {
    return invalid();
  }
}

async function normalizeVideos(config, workspace, composition, records, plan) {
  for (const job of composition.videoJobs) {
    await execute(config, workspace.workspacePath, [
      '-v', 'error', '-xerror', '-nostdin', '-y',
      '-i', sourcePath(records, plan, job.sourceOrdinal, 'video'),
      '-map', '0:v:0', '-an', '-vf', job.filter,
      '-t', job.durationSeconds,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-r', '24', '-fps_mode', 'cfr',
      '-video_track_timescale', '90000', '-movflags', '+faststart', job.outputFile,
    ]);
  }
  await execute(config, workspace.workspacePath, [
    '-v', 'error', '-xerror', '-nostdin', '-y', '-f', 'concat', '-safe', '1',
    '-i', 'video-concat.txt', '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-movflags', '+faststart', 'video-track.mp4',
  ]);
}

async function normalizeDialogue(config, workspace, composition, records, plan) {
  for (const job of composition.dialogueJobs) {
    await execute(config, workspace.workspacePath, [
      '-v', 'error', '-xerror', '-nostdin', '-y',
      '-i', sourcePath(records, plan, job.sourceOrdinal, 'audio'),
      '-map', '0:a:0', '-vn',
      '-af', `atrim=duration=${job.durationSeconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,apad=pad_dur=${job.durationSeconds},atrim=duration=${job.durationSeconds}`,
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', job.outputFile,
    ]);
  }
  if (composition.dialogueJobs.length > 0) {
    await execute(config, workspace.workspacePath, [
      '-v', 'error', '-xerror', '-nostdin', '-y', '-f', 'concat', '-safe', '1',
      '-i', 'dialogue-concat.txt', '-map', '0:a:0', '-c:a', 'pcm_s16le',
      '-ar', '48000', '-ac', '2', 'dialogue-track.wav',
    ]);
  }
}

async function normalizeNative(config, workspace, composition, records, plan) {
  if (composition.nativeSourceOrdinal === null) return;
  await execute(config, workspace.workspacePath, [
    '-v', 'error', '-xerror', '-nostdin', '-y',
    '-i', sourcePath(records, plan, composition.nativeSourceOrdinal, 'audio'),
    '-map', '0:a:0', '-vn',
    '-af', `atrim=duration=${composition.durationSeconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,apad=pad_dur=${composition.durationSeconds},atrim=duration=${composition.durationSeconds}`,
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', 'native-track.wav',
  ]);
}

async function mixAudio(config, workspace, composition, records, plan) {
  const args = ['-v', 'error', '-xerror', '-nostdin', '-y'];
  for (const input of composition.audioInputs) {
    if (input.kind === 'bgm') {
      args.push('-stream_loop', String(input.loopCount - 1), '-i',
        sourcePath(records, plan, input.sourceOrdinal, 'audio'));
    } else {
      args.push('-i', input.file);
    }
  }
  args.push(
    '-filter_complex_script', 'audio-filter.txt', '-map', '[mixout]',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', composition.durationSeconds, 'audio-track.m4a',
  );
  await execute(config, workspace.workspacePath, args);
}

async function renderFinal(config, workspace, composition) {
  await execute(config, workspace.workspacePath, [
    '-v', 'error', '-xerror', '-nostdin', '-y',
    '-i', 'video-track.mp4', '-i', 'audio-track.m4a',
    '-filter_complex_script', 'video-filter.txt', '-map', '[vout]', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', '24', '-fps_mode', 'cfr', '-video_track_timescale', '90000',
    '-c:a', 'copy', '-movflags', '+faststart', '-t', composition.durationSeconds,
    'final-candidate.mp4',
  ]);
  return path.join(workspace.workspacePath, 'final-candidate.mp4');
}

function createLocalMediaExporter(value) {
  const config = configuration(value);
  const outputVerifier = createMediaExportOutputVerifier({
    ffprobePath: config.ffprobePath,
    ffmpegPath: config.ffmpegPath,
    runProcess: config.runProcess,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  });
  return Object.freeze({
    async export(valueToExport) {
      try {
        const input = exactObject(valueToExport, EXPORT_KEYS, INPUT_CODE);
        if (input.schemaVersion !== '8.0') invalid(INPUT_CODE);
        const plan = requireTrustedMediaExportExecutionPlan(input.executionPlan);
        const completedAtEpochMs = epoch(input.completedAtEpochMs, INPUT_CODE);
        if (completedAtEpochMs < plan.createdAtEpochMs) invalid(INPUT_CODE);
        const composition = createFfmpegComposition(plan);
        const workspace = await createMediaExportWorkspace(config, plan);
        const records = await resolveSources(config, plan);
        await writeArtifact(workspace.workspacePath, 'subtitles.ass', plan.subtitleDocument.content);
        await writeArtifact(workspace.workspacePath, 'video-concat.txt', composition.videoConcatDocument);
        if (composition.dialogueConcatDocument !== null) {
          await writeArtifact(
            workspace.workspacePath, 'dialogue-concat.txt', composition.dialogueConcatDocument,
          );
        }
        await writeArtifact(workspace.workspacePath, 'audio-filter.txt', composition.audioFilterScript);
        await writeArtifact(workspace.workspacePath, 'video-filter.txt', composition.videoFilterScript);
        await normalizeVideos(config, workspace, composition, records, plan);
        await normalizeDialogue(config, workspace, composition, records, plan);
        await normalizeNative(config, workspace, composition, records, plan);
        await mixAudio(config, workspace, composition, records, plan);
        const candidatePath = await renderFinal(config, workspace, composition);
        const candidateReceipt = await outputVerifier.verify({
          schemaVersion: '8.0',
          executionPlan: plan,
          candidatePath,
          completedAtEpochMs,
        });
        await assertSourcesUnchanged(config, records);
        await assertMediaExportWorkspaceUnchanged(workspace);
        const installation = await installMediaExportCandidate(workspace, candidatePath);
        try {
          const finalReceipt = await outputVerifier.verify({
            schemaVersion: '8.0',
            executionPlan: plan,
            candidatePath: installation.targetPath,
            completedAtEpochMs,
          });
          if (finalReceipt.receiptSha256 !== candidateReceipt.receiptSha256
            || finalReceipt.output.sha256 !== candidateReceipt.output.sha256
            || finalReceipt.output.bytes !== candidateReceipt.output.bytes) invalid();
          return finalReceipt;
        } catch (error) {
          try {
            await rollbackMediaExportInstallation(installation);
          } catch { /* fixed export failure below */ }
          throw error;
        }
      } catch (error) {
        return safeError(error);
      }
    },
  });
}

module.exports = Object.freeze({ createLocalMediaExporter });
