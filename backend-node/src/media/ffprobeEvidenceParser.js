'use strict';

const { fail } = require('../audio/audioContract');
const { parseStrictJson } = require('../security/strictJson');

const CODE = 'MEDIA_PROBE_FAILED';
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

function invalid() {
  fail(CODE);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function decimalMilliseconds(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,9})?$/u.test(value)) invalid();
  const milliseconds = Math.round(Number(value) * 1000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3_600_000) invalid();
  return milliseconds;
}

function integerString(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) invalid();
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < minimum || integer > maximum) invalid();
  return integer;
}

function rationalString(value, denominatorMaximum = 1_000_000_000) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}\/[1-9][0-9]{0,9}$/u.test(value)) invalid();
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator > 1_000_000 || denominator > denominatorMaximum) invalid();
  return Object.freeze({ numerator, denominator });
}

function aspectRatio(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/u.test(value)) invalid();
  return value;
}

function token(value, maximumLength = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength
    || value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:+()-]*$/u.test(value)) invalid();
  return value;
}

function formatNames(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || !/^[a-z0-9][a-z0-9,_-]*$/u.test(value)) invalid();
  const names = value.split(',');
  if (names.length < 1 || names.length > 16
    || names.some((name) => !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(name))) invalid();
  const unique = [...new Set(names)].sort();
  if (unique.length !== names.length) invalid();
  return Object.freeze(unique);
}

function parseFfprobeEvidence(text, mimeType) {
  try {
    const parsed = parseStrictJson(text, MAX_PROCESS_OUTPUT_BYTES);
    if (!plainObject(parsed) || !Array.isArray(parsed.streams) || !plainObject(parsed.format)) invalid();
    const streams = parsed.streams;
    if (streams.length < 1 || streams.length > 2 || streams.some((stream) => !plainObject(stream))) invalid();
    const videos = streams.filter((stream) => stream.codec_type === 'video');
    const audios = streams.filter((stream) => stream.codec_type === 'audio');
    if (videos.length + audios.length !== streams.length || videos.length > 1 || audios.length > 1) invalid();
    const videoExpected = mimeType === 'video/mp4';
    if ((videoExpected && videos.length !== 1) || (!videoExpected && (videos.length !== 0 || audios.length !== 1))) {
      invalid();
    }
    const videoStream = videos[0];
    const audioStream = audios[0];
    const video = videoStream ? Object.freeze({
      codecName: token(videoStream.codec_name, 64),
      width: Number.isSafeInteger(videoStream.width) && videoStream.width > 0 ? videoStream.width : invalid(),
      height: Number.isSafeInteger(videoStream.height) && videoStream.height > 0 ? videoStream.height : invalid(),
      pixelFormat: token(videoStream.pix_fmt, 64),
      averageFrameRate: rationalString(videoStream.avg_frame_rate),
      timeBase: rationalString(videoStream.time_base),
      sampleAspectRatio: aspectRatio(videoStream.sample_aspect_ratio),
      displayAspectRatio: aspectRatio(videoStream.display_aspect_ratio),
      frameCount: integerString(videoStream.nb_read_frames ?? videoStream.nb_frames, 1, 10_000_000),
    }) : null;
    const audio = audioStream ? Object.freeze({
      codecName: token(audioStream.codec_name, 64),
      sampleRateHz: integerString(audioStream.sample_rate, 8_000, 384_000),
      channels: Number.isSafeInteger(audioStream.channels) && audioStream.channels > 0
        && audioStream.channels <= 32 ? audioStream.channels : invalid(),
      channelLayout: token(audioStream.channel_layout, 128),
      sampleFormat: token(audioStream.sample_fmt, 64),
    }) : null;
    return Object.freeze({
      durationMs: decimalMilliseconds(parsed.format.duration),
      formatNames: formatNames(parsed.format.format_name),
      video,
      audio,
    });
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({ parseFfprobeEvidence });
