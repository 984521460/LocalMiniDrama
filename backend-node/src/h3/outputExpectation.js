'use strict';

const { isProviderNeutralText } = require('../narrative/tasks/providerNeutralText');
const { boundedText, exactKeys, snapshot } = require('./contract');
const { fail } = require('./errors');
const { h3FramesForDuration } = require('./generationSpec');
const { H3_PROFILE } = require('./profile');

const CODE = 'H3_OUTPUT_INVALID';
const MAXIMUM_FRAMES = h3FramesForDuration(15);

function validateH3OutputExpectation(value) {
  const expected = snapshot(value, CODE);
  exactKeys(expected, ['width', 'height', 'durationMs', 'fps'], CODE);
  if (!Number.isSafeInteger(expected.width) || !Number.isSafeInteger(expected.height)
    || expected.width < H3_PROFILE.canvas.multipleOf
    || expected.height < H3_PROFILE.canvas.multipleOf
    || expected.width % H3_PROFILE.canvas.multipleOf !== 0
    || expected.height % H3_PROFILE.canvas.multipleOf !== 0
    || Math.max(expected.width, expected.height) > H3_PROFILE.canvas.maximumLongEdge
    || Math.min(expected.width, expected.height) > H3_PROFILE.canvas.maximumShortEdge
    || expected.width * expected.height > H3_PROFILE.canvas.maximumPixels
    || expected.fps !== H3_PROFILE.fps
    || !Number.isSafeInteger(expected.durationMs) || expected.durationMs < 1) fail(CODE);
  const frames = Math.round((expected.durationMs / 1000) * expected.fps);
  if (frames < H3_PROFILE.frameGrid.minimum || frames > MAXIMUM_FRAMES
    || (frames - H3_PROFILE.frameGrid.offset) % H3_PROFILE.frameGrid.stride !== 0
    || expected.durationMs !== Math.round((frames / expected.fps) * 1000)) fail(CODE);
  return snapshot({ ...expected, frames }, CODE);
}

function safeFilenamePrefix(value) {
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 512 || value.includes('\0') || value.includes('\\')
    || value.includes(':') || value.startsWith('/') || value.endsWith('/')) fail(CODE);
  const segments = value.split('/');
  if (segments.length > 16 || segments.some((segment) => (
    segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment)
  ))) fail(CODE);
  return value;
}

function validateH3WorkflowValues(value, expected, seed) {
  const values = snapshot(value, CODE);
  exactKeys(values, ['prompt', 'width', 'height', 'frames', 'seed', 'filenamePrefix'], CODE);
  boundedText(values.prompt, 12_000, 32 * 1024, CODE);
  if (!isProviderNeutralText(values.prompt)
    || values.width !== expected.width || values.height !== expected.height
    || values.frames !== expected.frames || values.seed !== seed
    || !Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295) fail(CODE);
  safeFilenamePrefix(values.filenamePrefix);
  return values;
}

module.exports = Object.freeze({
  validateH3OutputExpectation,
  validateH3WorkflowValues,
});
