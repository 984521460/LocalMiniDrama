'use strict';

const { types: { isProxy } } = require('node:util');

const { snapshot } = require('./contract');
const { fail } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');

const CODE = 'H3_API_REQUEST_INVALID';
const PROVIDER_OPTIONS_ERROR = 'MiniMax H3 API provider configuration is invalid';

function providerOptions(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
      throw new TypeError(PROVIDER_OPTIONS_ERROR);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 1 || keys[0] !== 'resolveMediaUrl') {
      throw new TypeError(PROVIDER_OPTIONS_ERROR);
    }
    const descriptor = descriptors.resolveMediaUrl;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
      throw new TypeError(PROVIDER_OPTIONS_ERROR);
    }
    return Object.freeze({ resolveMediaUrl: descriptor.value });
  } catch (error) {
    if (error instanceof TypeError && error.message === PROVIDER_OPTIONS_ERROR) throw error;
    throw new TypeError(PROVIDER_OPTIONS_ERROR);
  }
}

function safeMediaUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) fail(CODE);
  let parsed;
  try { parsed = new URL(value); } catch { return fail(CODE); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')
    || parsed.href !== value) fail(CODE);
  return value;
}

function contentFor(spec, resolveMediaUrl) {
  const content = [{ type: 'text', text: spec.prompt.text }];
  for (const reference of spec.referenceImages) {
    let url;
    try {
      url = Reflect.apply(
        resolveMediaUrl,
        undefined,
        [reference.assetVersionUid, reference],
      );
    } catch {
      return fail(CODE);
    }
    if (url && typeof url === 'object') fail(CODE);
    const role = reference.role === 'first'
      ? 'first_frame'
      : reference.role === 'last' ? 'last_frame' : 'reference_image';
    content.push({ type: 'image_url', image_url: { url: safeMediaUrl(url) }, role });
  }
  if (spec.referenceAudio !== null) {
    let url;
    try {
      url = Reflect.apply(
        resolveMediaUrl,
        undefined,
        [spec.referenceAudio.assetVersionUid, spec.referenceAudio],
      );
    } catch {
      return fail(CODE);
    }
    if (url && typeof url === 'object') fail(CODE);
    content.push({
      type: 'audio_url',
      audio_url: { url: safeMediaUrl(url) },
      role: 'reference_audio',
    });
  }
  return content;
}

function createMinimaxH3ApiProvider(options) {
  const configured = providerOptions(options);
  return Object.freeze({
    buildRequest(value) {
      let spec;
      try { spec = validateH3GenerationSpec(value); } catch { return fail(CODE); }
      if (!Number.isSafeInteger(spec.durationSeconds)
        || spec.durationSeconds < 4 || spec.durationSeconds > 15
        || (spec.referenceAudio !== null
          && (spec.mode === 'fl2va-first' || spec.mode === 'fl2va-first-last'))) fail(CODE);
      const request = {
        model: 'MiniMax-H3',
        content: contentFor(spec, configured.resolveMediaUrl),
        duration: spec.durationSeconds,
        resolution: '768P',
      };
      if (spec.mode === 't2v') request.ratio = '16:9';
      else if (spec.mode === 'fl2va-first' || spec.mode === 'fl2va-first-last') {
        request.ratio = 'adaptive';
      }
      return snapshot(request, CODE, {
        maxArrayLength: 16,
        maxDepth: 8,
        maxEntries: 128,
        maxStringBytes: 32 * 1024,
        maxTotalBytes: 128 * 1024,
      });
    },
  });
}

module.exports = Object.freeze({ createMinimaxH3ApiProvider });
