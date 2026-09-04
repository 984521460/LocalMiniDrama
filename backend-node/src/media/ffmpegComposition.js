'use strict';

const {
  canonicalHash,
  fail,
  frozenArray,
} = require('../audio/audioContract');
const {
  requireTrustedMediaExportExecutionPlan,
} = require('./mediaExportExecutionPlan');

const INPUT_CODE = 'MEDIA_EXPORT_INPUT_INVALID';
const COMPOSITION_SCHEMA_VERSION = 'ffmpeg-composition.v1';
const COMPOSITION_ALGORITHM_VERSION = 'ffmpeg-filter-graph.v2';

function invalid() {
  fail(INPUT_CODE);
}

function seconds(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 3_600_000) {
    invalid();
  }
  return (milliseconds / 1000).toFixed(3);
}

function gainScalar(milliDb) {
  if (!Number.isSafeInteger(milliDb) || milliDb < -60_000 || milliDb > 12_000) invalid();
  return (10 ** (milliDb / 20_000)).toFixed(9);
}

function fileName(prefix, ordinal, extension) {
  return `${prefix}-${String(ordinal).padStart(4, '0')}.${extension}`;
}

function concatDocument(files) {
  if (!Array.isArray(files) || files.length < 1
    || files.some((file) => !/^[A-Za-z0-9._-]{1,128}$/u.test(file))) invalid();
  return `${files.map((file) => `file '${file}'`).join('\n')}\n`;
}

function videoJobs(plan) {
  return frozenArray(plan.videoSources.map((source) => Object.freeze({
    ordinal: source.ordinal,
    sourceOrdinal: source.ordinal,
    outputFile: fileName('video', source.ordinal, 'mp4'),
    durationSeconds: seconds(source.durationMs),
    filter: `scale=${plan.profile.video.width}:${plan.profile.video.height}:force_original_aspect_ratio=decrease,pad=${plan.profile.video.width}:${plan.profile.video.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24`,
  })));
}

function dialogueJobs(plan) {
  const sources = plan.audioSources.filter((source) => source.role === 'dialogue');
  const jobs = [];
  for (const source of sources) {
    for (const placement of source.placements) {
      if (placement.endMs - placement.startMs !== source.durationMs) invalid();
      const ordinal = jobs.length;
      jobs.push(Object.freeze({
        ordinal,
        sourceOrdinal: source.ordinal,
        outputFile: fileName('dialogue', ordinal, 'wav'),
        durationSeconds: seconds(source.durationMs),
        startMs: placement.startMs,
        endMs: placement.endMs,
      }));
    }
  }
  return frozenArray(jobs);
}

function bgmVolumeFilter(mix) {
  const base = gainScalar(mix.bgm.baseGainMilliDb);
  const ducked = gainScalar(mix.bgm.duckedGainMilliDb);
  let expression = base;
  for (let index = mix.ducking.windows.length - 1; index >= 0; index -= 1) {
    const window = mix.ducking.windows[index];
    expression = `if(between(t,${seconds(window.startMs)},${seconds(window.endMs)}),${ducked},${expression})`;
  }
  const filters = [
    'aresample=48000',
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    `volume='${expression}':eval=frame`,
  ];
  if (mix.bgm.fadeInMs > 0) {
    filters.push(`afade=t=in:st=0:d=${seconds(mix.bgm.fadeInMs)}`);
  }
  if (mix.bgm.fadeOutMs > 0) {
    filters.push(`afade=t=out:st=${seconds(mix.durationMs - mix.bgm.fadeOutMs)}:d=${seconds(mix.bgm.fadeOutMs)}`);
  }
  filters.push(`atrim=duration=${seconds(mix.durationMs)}`, 'asetpts=PTS-STARTPTS');
  return filters.join(',');
}

function audioMix(plan, dialogue, nativeSource, bgmSource) {
  const inputs = [];
  const filters = [];
  const foregroundLabels = [];
  for (const job of dialogue) {
    const inputIndex = inputs.length;
    const label = `dialogue${job.ordinal}`;
    inputs.push(Object.freeze({ kind: 'dialogue', file: job.outputFile }));
    filters.push(`[${inputIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gainScalar(plan.audioMixPlan.dialogueGainMilliDb)},adelay=${job.startMs}|${job.startMs},apad=whole_dur=${seconds(plan.durationMs)},atrim=duration=${seconds(plan.durationMs)}[${label}]`);
    foregroundLabels.push(`[${label}]`);
  }
  if (nativeSource !== null) {
    const inputIndex = inputs.length;
    inputs.push(Object.freeze({ kind: 'native', file: 'native-track.wav' }));
    filters.push(`[${inputIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gainScalar(plan.audioMixPlan.nativeGainMilliDb)},atrim=duration=${seconds(plan.durationMs)}[native]`);
    foregroundLabels.push('[native]');
  }
  if ((plan.mode === 'independent_tts' && dialogue.length < 1)
    || (plan.mode === 'h3_native' && foregroundLabels.length !== 1)
    || (plan.mode === 'hybrid' && (dialogue.length < 1
      || foregroundLabels.length !== dialogue.length + 1))) invalid();
  const bgmInputIndex = inputs.length;
  inputs.push(Object.freeze({
    kind: 'bgm',
    sourceOrdinal: bgmSource.ordinal,
    loopCount: plan.audioMixPlan.bgm.loopCount,
  }));
  filters.push(`[${bgmInputIndex}:a:0]${bgmVolumeFilter(plan.audioMixPlan)}[bgm]`);
  const labels = [...foregroundLabels, '[bgm]'];
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=0.950000,atrim=duration=${seconds(plan.durationMs)},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[mixout]`);
  return Object.freeze({ inputs: frozenArray(inputs), filterScript: `${filters.join(';\n')}\n` });
}

function createFfmpegComposition(value) {
  try {
    const plan = requireTrustedMediaExportExecutionPlan(value);
    const videos = videoJobs(plan);
    const dialogue = dialogueJobs(plan);
    const nativeSource = plan.audioSources.find((source) => source.role === 'native') ?? null;
    const bgmSource = plan.audioSources.find((source) => source.role === 'bgm');
    if (!bgmSource || plan.audioSources.filter((source) => source.role === 'bgm').length !== 1
      || plan.audioSources.filter((source) => source.role === 'native').length > 1) invalid();
    const mix = audioMix(plan, dialogue, nativeSource, bgmSource);
    const base = Object.freeze({
      schemaVersion: COMPOSITION_SCHEMA_VERSION,
      algorithmVersion: COMPOSITION_ALGORITHM_VERSION,
      executionPlanUid: plan.uid,
      executionPlanSha256: plan.executionPlanSha256,
      durationSeconds: seconds(plan.durationMs),
      videoJobs: videos,
      videoConcatDocument: concatDocument(videos.map((job) => job.outputFile)),
      dialogueJobs: dialogue,
      dialogueConcatDocument: null,
      nativeSourceOrdinal: nativeSource?.ordinal ?? null,
      bgmSourceOrdinal: bgmSource.ordinal,
      bgmLoopCount: plan.audioMixPlan.bgm.loopCount,
      audioInputs: mix.inputs,
      audioFilterScript: mix.filterScript,
      videoFilterScript: '[0:v:0]ass=filename=subtitles.ass[vout]\n',
    });
    return Object.freeze({ ...base, compositionSha256: canonicalHash(base) });
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({
  COMPOSITION_ALGORITHM_VERSION,
  COMPOSITION_SCHEMA_VERSION,
  createFfmpegComposition,
});
