'use strict';

const {
  canonicalHash,
  fail,
  textHash,
} = require('../audio/audioContract');
const {
  requireTrustedProductionTimelineSnapshot,
} = require('../audio/productionTimelineSnapshot');

const INPUT_CODE = 'MEDIA_EXPORT_INPUT_INVALID';
const MAX_DURATION_MS = 3_600_000;
const MAX_TEXT_CODE_POINTS = 4_000;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const ASS_SCHEMA_VERSION = 'ass-subtitle-document.v1';
const ASS_ALGORITHM_VERSION = 'ass-burn-in-centisecond.v1';

function invalid() {
  fail(INPUT_CODE);
}

function safeTimeline(value) {
  try {
    return requireTrustedProductionTimelineSnapshot(value);
  } catch {
    return invalid();
  }
}

function formatCentiseconds(centiseconds) {
  if (!Number.isSafeInteger(centiseconds) || centiseconds < 0
    || centiseconds > MAX_DURATION_MS / 10) invalid();
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

function formatAssTimestamp(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0
    || milliseconds > MAX_DURATION_MS) invalid();
  return formatCentiseconds(Math.round(milliseconds / 10));
}

function escapeAssSubtitleText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT_CODE_POINTS * 2) {
    invalid();
  }
  const normalized = value.replace(/\r\n|\r|\n/gu, '\n');
  if (Array.from(normalized).length > MAX_TEXT_CODE_POINTS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) invalid();
  return normalized
    .replace(/\\/gu, '\\\\')
    .replace(/\{/gu, '\\{')
    .replace(/\}/gu, '\\}')
    .replace(/\t/gu, ' ')
    .replace(/\n/gu, '\\N');
}

function cueLine(cue) {
  const startCentiseconds = Math.round(cue.startMs / 10);
  const endCentiseconds = Math.round(cue.endMs / 10);
  if (endCentiseconds <= startCentiseconds) invalid();
  return `Dialogue: 0,${formatCentiseconds(startCentiseconds)},${formatCentiseconds(endCentiseconds)},Default,,0,0,0,,${escapeAssSubtitleText(cue.text)}`;
}

function createAssSubtitleDocument(value) {
  try {
    const timeline = safeTimeline(value);
    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1920',
      'PlayResY: 1080',
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,sans-serif,52,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,54,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const lines = timeline.subtitleTrack.cues.map(cueLine);
    const content = `${[...header, ...lines].join('\n')}\n`;
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) invalid();
    const base = Object.freeze({
      schemaVersion: ASS_SCHEMA_VERSION,
      algorithmVersion: ASS_ALGORITHM_VERSION,
      timelineUid: timeline.audioTimeline.uid,
      trackSha256: timeline.subtitleTrack.trackSha256,
      cueCount: timeline.subtitleTrack.cues.length,
      content,
      contentSha256: textHash(content),
    });
    return Object.freeze({ ...base, documentSha256: canonicalHash(base) });
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({
  ASS_ALGORITHM_VERSION,
  ASS_SCHEMA_VERSION,
  createAssSubtitleDocument,
  escapeAssSubtitleText,
  formatAssTimestamp,
});
