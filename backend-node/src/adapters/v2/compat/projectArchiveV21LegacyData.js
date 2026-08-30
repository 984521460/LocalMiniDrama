'use strict';

const { types } = require('node:util');

const { archiveError, isProjectArchiveError } = require('../zip/errors');
const { PROJECT_ARCHIVE_CATALOG } = require('../zip/projectArchiveCatalog');
const {
  projectProjectArchiveV21PortableField,
} = require('../zip/projectArchiveV21PortableBindings');

const MAX_RECORDS = 100000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STRING_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 64;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PORTABLE_SEGMENT = /^(?!\.{1,2}$)[^\\/\u0000-\u001f\u007f]+$/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const HEX = /^[0-9a-fA-F]{4}$/u;

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const JSON_PARSE = JSON.parse;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_IS_FROZEN = Object.isFrozen;
const OBJECT_KEYS = Object.keys;
const REGEXP_EXEC = RegExp.prototype.exec;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_CONSTRUCTOR = String;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_INCLUDES = String.prototype.includes;
const STRING_SLICE = String.prototype.slice;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_TRIM = String.prototype.trim;

function spec(table, columns, options = {}) {
  return freezeObject({
    table,
    columns: freezeObject(columns),
    integers: freezeObject(options.integers || []),
    numbers: freezeObject(options.numbers || []),
    json: freezeObject(options.json || {}),
    paths: freezeObject(options.paths || []),
    urls: freezeObject(options.urls || []),
    forcedNull: freezeObject(options.forcedNull || []),
    forbiddenNonNull: freezeObject(options.forbiddenNonNull || []),
    order: freezeObject(options.order || ['id']),
  });
}

const LEGACY_RECORD_SPECS = freezeObject({
  dramas: spec('dramas', [
    'id', 'uid', 'title', 'description', 'genre', 'style', 'tags', 'thumbnail',
    'total_episodes', 'total_duration', 'status', 'metadata', 'created_at',
    'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'total_episodes', 'total_duration'],
    json: { metadata: 'object' },
    urls: ['thumbnail'],
  }),
  episodes: spec('episodes', [
    'id', 'uid', 'drama_id', 'episode_number', 'title', 'script_content',
    'description', 'duration', 'video_url', 'thumbnail', 'status', 'created_at',
    'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id', 'episode_number', 'duration'],
    urls: ['video_url', 'thumbnail'],
  }),
  storyboards: spec('storyboards', [
    'id', 'uid', 'episode_id', 'scene_id', 'storyboard_number', 'title',
    'description', 'layout_description', 'location', 'time', 'duration', 'dialogue',
    'narration', 'action', 'atmosphere', 'image_prompt', 'video_prompt', 'characters',
    'shot_type', 'angle', 'movement', 'image_url', 'local_path', 'main_panel_idx',
    'video_url', 'composed_image', 'result', 'emotion', 'emotion_intensity',
    'segment_index', 'segment_title', 'angle_h', 'angle_v', 'angle_s',
    'lighting_style', 'depth_of_field', 'polished_prompt', 'continuity_snapshot',
    'audio_local_path', 'narration_audio_local_path', 'creation_mode',
    'universal_segment_text', 'first_frame_image_id', 'last_frame_image_id',
    'last_frame_image_url', 'last_frame_local_path', 'status', 'error_msg',
    'created_at', 'updated_at', 'deleted_at',
  ], {
    integers: [
      'id', 'episode_id', 'scene_id', 'storyboard_number', 'main_panel_idx',
      'segment_index', 'first_frame_image_id', 'last_frame_image_id',
    ],
    numbers: ['duration', 'emotion_intensity'],
    json: { continuity_snapshot: 'object' },
    paths: ['local_path', 'audio_local_path', 'narration_audio_local_path', 'last_frame_local_path'],
    urls: ['image_url', 'video_url', 'composed_image', 'last_frame_image_url'],
    forcedNull: ['error_msg'],
  }),
  characters: spec('characters', [
    'id', 'uid', 'drama_id', 'name', 'role', 'description', 'personality',
    'appearance', 'image_url', 'local_path', 'extra_images', 'voice_style',
    'sort_order', 'identity_anchors', 'style_tokens', 'color_palette',
    'four_view_image_url', 'polished_prompt', 'ref_image', 'stages',
    'seedance2_asset', 'seedance2_voice_asset', 'negative_prompt', 'error_msg',
    'created_at', 'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id', 'sort_order'],
    json: {
      extra_images: 'array', identity_anchors: 'object', style_tokens: 'array',
      color_palette: 'array', stages: 'array', seedance2_asset: 'object',
      seedance2_voice_asset: 'object',
    },
    paths: ['local_path', 'ref_image'],
    urls: ['image_url', 'four_view_image_url'],
    forcedNull: ['error_msg'],
  }),
  scenes: spec('scenes', [
    'id', 'uid', 'drama_id', 'episode_id', 'location', 'time', 'prompt',
    'polished_prompt', 'image_url', 'local_path', 'extra_images', 'ref_image',
    'negative_prompt', 'storyboard_count', 'status', 'error_msg', 'created_at',
    'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id', 'episode_id', 'storyboard_count'],
    json: { extra_images: 'array' },
    paths: ['local_path', 'ref_image'],
    urls: ['image_url'],
    forcedNull: ['error_msg'],
  }),
  props: spec('props', [
    'id', 'uid', 'drama_id', 'episode_id', 'name', 'type', 'description',
    'prompt', 'image_url', 'local_path', 'extra_images', 'ref_image',
    'negative_prompt', 'error_msg', 'created_at', 'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id', 'episode_id'],
    json: { extra_images: 'array' },
    paths: ['local_path', 'ref_image'],
    urls: ['image_url'],
    forcedNull: ['error_msg'],
  }),
  episodeCharacters: spec('episode_characters', ['episode_id', 'character_id'], {
    integers: ['episode_id', 'character_id'],
    order: ['episode_id', 'character_id'],
  }),
  storyboardCharacters: spec(
    'storyboard_characters',
    ['id', 'storyboard_id', 'character_id', 'created_at'],
    { integers: ['id', 'storyboard_id', 'character_id'], order: ['storyboard_id', 'character_id', 'id'] },
  ),
  storyboardProps: spec('storyboard_props', ['storyboard_id', 'prop_id'], {
    integers: ['storyboard_id', 'prop_id'],
    order: ['storyboard_id', 'prop_id'],
  }),
  characterLibraries: spec('character_libraries', [
    'id', 'drama_id', 'name', 'category', 'image_url', 'local_path', 'description',
    'appearance', 'tags', 'source_type', 'source_id', 'identity_anchors',
    'style_tokens', 'color_palette', 'four_view_image_url', 'created_at',
    'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id'],
    json: { identity_anchors: 'object', style_tokens: 'array', color_palette: 'array' },
    paths: ['local_path'],
    urls: ['image_url', 'four_view_image_url'],
  }),
  sceneLibraries: spec('scene_libraries', [
    'id', 'drama_id', 'location', 'time', 'prompt', 'description', 'image_url',
    'local_path', 'category', 'tags', 'source_type', 'source_id', 'created_at',
    'updated_at', 'deleted_at',
  ], { integers: ['id', 'drama_id'], paths: ['local_path'], urls: ['image_url'] }),
  propLibraries: spec('prop_libraries', [
    'id', 'drama_id', 'name', 'description', 'prompt', 'image_url', 'local_path',
    'category', 'tags', 'source_type', 'source_id', 'created_at', 'updated_at',
    'deleted_at',
  ], { integers: ['id', 'drama_id'], paths: ['local_path'], urls: ['image_url'] }),
  legacyAssets: spec('legacy_assets', [
    'id', 'drama_id', 'name', 'type', 'category', 'url', 'local_path', 'file_size',
    'mime_type', 'width', 'height', 'duration', 'image_gen_id', 'video_gen_id',
    'created_at', 'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id', 'file_size', 'width', 'height', 'image_gen_id', 'video_gen_id'],
    numbers: ['duration'],
    paths: ['local_path'],
    urls: ['url'],
  }),
  framePrompts: spec('frame_prompts', [
    'id', 'storyboard_id', 'frame_type', 'prompt', 'description', 'layout',
    'created_at', 'updated_at',
  ], { integers: ['id', 'storyboard_id'], order: ['storyboard_id', 'id'] }),
  imageGenerations: spec('image_generations', [
    'id', 'storyboard_id', 'drama_id', 'episode_id', 'scene_id', 'character_id',
    'provider', 'prompt', 'negative_prompt', 'model', 'frame_type', 'reference_images',
    'use_first_frame_layout_lock', 'size', 'quality', 'image_url', 'local_path',
    'width', 'height', 'status', 'task_id', 'completed_at', 'error_msg',
    'created_at', 'updated_at', 'deleted_at',
  ], {
    integers: [
      'id', 'storyboard_id', 'drama_id', 'episode_id', 'scene_id', 'character_id',
      'use_first_frame_layout_lock', 'width', 'height',
    ],
    json: { reference_images: 'array' },
    paths: ['local_path'],
    urls: ['image_url'],
    forcedNull: ['error_msg'],
    forbiddenNonNull: ['task_id'],
  }),
  videoGenerations: spec('video_generations', [
    'id', 'drama_id', 'storyboard_id', 'scene_id', 'provider', 'prompt', 'model',
    'duration', 'aspect_ratio', 'resolution', 'seed', 'camera_fixed', 'watermark',
    'image_url', 'first_frame_url', 'last_frame_url', 'reference_image_urls',
    'video_url', 'local_path', 'status', 'task_id', 'provider_task_id', 'completed_at',
    'error_msg', 'created_at', 'updated_at', 'deleted_at',
  ], {
    integers: ['id', 'drama_id', 'storyboard_id', 'scene_id', 'seed', 'camera_fixed', 'watermark'],
    numbers: ['duration'],
    json: { reference_image_urls: 'array' },
    paths: ['local_path'],
    urls: ['image_url', 'first_frame_url', 'last_frame_url', 'video_url'],
    forcedNull: ['error_msg'],
    forbiddenNonNull: ['task_id', 'provider_task_id'],
  }),
  videoMerges: spec('video_merges', [
    'id', 'episode_id', 'drama_id', 'title', 'provider', 'model', 'status', 'scenes',
    'merge_options', 'task_id', 'merged_url', 'duration', 'completed_at', 'error_msg',
    'created_at', 'deleted_at',
  ], {
    integers: ['id', 'episode_id', 'drama_id', 'duration'],
    json: { scenes: 'array', merge_options: 'object' },
    urls: ['merged_url'],
    forcedNull: ['error_msg'],
    forbiddenNonNull: ['task_id'],
  }),
});

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function secretDetected() {
  throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
}

function arrayIsArray(value) {
  return REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [value]);
}

function objectKeys(value) {
  return REFLECT_APPLY(OBJECT_KEYS, Object, [value]);
}

function hasOwn(value, key) {
  return REFLECT_APPLY(OBJECT_HAS_OWN, Object, [value, key]);
}

function slice(value, start, end) {
  return REFLECT_APPLY(STRING_SLICE, value, end === undefined ? [start] : [start, end]);
}

function byteLength(value) {
  return REFLECT_APPLY(BUFFER_BYTE_LENGTH, Buffer, [value, 'utf8']);
}

function charCodeAt(value, index) {
  return REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]);
}

function stringIncludes(value, search) {
  return REFLECT_APPLY(STRING_INCLUDES, value, [search]);
}

function stringStartsWith(value, search) {
  return REFLECT_APPLY(STRING_STARTS_WITH, value, [search]);
}

function stringEndsWith(value, search) {
  return REFLECT_APPLY(STRING_ENDS_WITH, value, [search]);
}

function stringTrim(value) {
  return REFLECT_APPLY(STRING_TRIM, value, []);
}

function stringSplit(value, separator) {
  return REFLECT_APPLY(STRING_SPLIT, value, [separator]);
}

function regexpMatches(pattern, value) {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function freezeObject(value) {
  return REFLECT_APPLY(OBJECT_FREEZE, Object, [value]);
}

function assertWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = charCodeAt(value, index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = charCodeAt(value, index + 1);
      if (next < 0xdc00 || next > 0xdfff) invalidManifest();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalidManifest();
    }
  }
}

function assertPortableStringsWellFormed(value) {
  const stack = [value];
  let cursor = 0;
  while (cursor < stack.length) {
    const current = stack[cursor];
    cursor += 1;
    if (typeof current === 'string') {
      assertWellFormedString(current);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [current]);
    const keys = REFLECT_OWN_KEYS(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key === 'string') assertWellFormedString(key);
      const descriptor = descriptors[key];
      if (hasOwn(descriptor, 'value')) stack[stack.length] = descriptor.value;
    }
  }
}

function quotedJsonByteLength(value) {
  assertWellFormedString(value);
  let bytes = byteLength(value) + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = charCodeAt(value, index);
    if (code === 0x22 || code === 0x5c
      || code === 0x08 || code === 0x09 || code === 0x0a
      || code === 0x0c || code === 0x0d) {
      bytes += 1;
    } else if (code < 0x20) {
      bytes += 5;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      index += 1;
    }
  }
  return bytes;
}

function portableJsonByteLength(value) {
  const stack = [value];
  let cursor = 0;
  let bytes = 0;
  const add = (amount) => {
    bytes += amount;
    if (!NUMBER_IS_SAFE_INTEGER(bytes) || bytes > MAX_TOTAL_BYTES) invalidManifest();
  };
  while (cursor < stack.length) {
    const current = stack[cursor];
    cursor += 1;
    if (current === null) {
      add(4);
      continue;
    }
    if (typeof current === 'boolean') {
      add(current ? 4 : 5);
      continue;
    }
    if (typeof current === 'number') {
      if (!NUMBER_IS_FINITE(current)) invalidManifest();
      add(byteLength(STRING_CONSTRUCTOR(current)));
      continue;
    }
    if (typeof current === 'string') {
      add(quotedJsonByteLength(current));
      continue;
    }
    if (typeof current !== 'object' || types.isProxy(current)) invalidManifest();
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [current]);
    const keys = REFLECT_OWN_KEYS(descriptors);
    if (arrayIsArray(current)) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !hasOwn(lengthDescriptor, 'value')
        || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || keys.length !== lengthDescriptor.value + 1) invalidManifest();
      add(2 + (lengthDescriptor.value === 0 ? 0 : lengthDescriptor.value - 1));
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[STRING_CONSTRUCTOR(index)];
        if (!descriptor || !hasOwn(descriptor, 'value')) invalidManifest();
        stack[stack.length] = descriptor.value;
      }
      continue;
    }
    add(2 + (keys.length === 0 ? 0 : keys.length - 1));
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor || !hasOwn(descriptor, 'value')) invalidManifest();
      add(quotedJsonByteLength(key) + 1);
      stack[stack.length] = descriptor.value;
    }
  }
  return bytes;
}

function exactObjectDescriptors(value, keys) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || arrayIsArray(value)) {
    invalidManifest();
  }
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  if (prototype !== Object.prototype && prototype !== null) invalidManifest();
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  const actual = REFLECT_OWN_KEYS(descriptors);
  if (actual.length !== keys.length) invalidManifest();
  const expected = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) expected[keys[index]] = true;
  for (let index = 0; index < actual.length; index += 1) {
    const key = actual[index];
    if (typeof key !== 'string' || expected[key] !== true) invalidManifest();
    const descriptor = descriptors[key];
    if (!hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalidManifest();
  }
  return descriptors;
}

function denseArrayValues(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !arrayIsArray(value)) {
    invalidManifest();
  }
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  if (prototype !== Array.prototype) invalidManifest();
  const lengthDescriptor = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, Object, [value, 'length']);
  if (!lengthDescriptor || !hasOwn(lengthDescriptor, 'value')
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_RECORDS) invalidManifest();
  const length = lengthDescriptor.value;
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  const keys = REFLECT_OWN_KEYS(descriptors);
  if (keys.length !== length + 1) invalidManifest();
  const result = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalidManifest();
    result[index] = descriptor.value;
  }
  return result;
}

function skipWhitespace(text, state) {
  while (state.index < text.length) {
    const code = charCodeAt(text, state.index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    state.index += 1;
  }
}

function parseJsonStringToken(text, state) {
  if (text[state.index] !== '"') invalidManifest();
  const start = state.index;
  state.index += 1;
  while (state.index < text.length) {
    const code = charCodeAt(text, state.index);
    if (code === 0x22) {
      state.index += 1;
      try {
        return JSON_PARSE(slice(text, start, state.index));
      } catch {
        invalidManifest();
      }
    }
    if (code < 0x20) invalidManifest();
    if (code === 0x5c) {
      state.index += 1;
      if (state.index >= text.length) invalidManifest();
      const escaped = text[state.index];
      if (escaped === 'u') {
        const hex = slice(text, state.index + 1, state.index + 5);
        if (hex.length !== 4 || !regexpMatches(HEX, hex)) invalidManifest();
        state.index += 5;
        continue;
      }
      if (!stringIncludes('"\\/bfnrt', escaped)) invalidManifest();
    }
    state.index += 1;
  }
  invalidManifest();
}

function isDigit(code) {
  return code >= 0x30 && code <= 0x39;
}

function parseJsonNumber(text, state) {
  const start = state.index;
  if (text[state.index] === '-') state.index += 1;
  if (text[state.index] === '0') {
    state.index += 1;
  } else {
    const first = charCodeAt(text, state.index);
    if (first < 0x31 || first > 0x39) invalidManifest();
    while (isDigit(charCodeAt(text, state.index))) state.index += 1;
  }
  if (text[state.index] === '.') {
    state.index += 1;
    if (!isDigit(charCodeAt(text, state.index))) invalidManifest();
    while (isDigit(charCodeAt(text, state.index))) state.index += 1;
  }
  if (text[state.index] === 'e' || text[state.index] === 'E') {
    state.index += 1;
    if (text[state.index] === '+' || text[state.index] === '-') state.index += 1;
    if (!isDigit(charCodeAt(text, state.index))) invalidManifest();
    while (isDigit(charCodeAt(text, state.index))) state.index += 1;
  }
  const value = NUMBER_CONSTRUCTOR(slice(text, start, state.index));
  if (!NUMBER_IS_FINITE(value)) invalidManifest();
}

function parseJsonValue(text, state, depth) {
  if (depth > MAX_JSON_DEPTH) invalidManifest();
  skipWhitespace(text, state);
  const token = text[state.index];
  if (token === '"') {
    parseJsonStringToken(text, state);
    return;
  }
  if (token === '{') {
    state.index += 1;
    skipWhitespace(text, state);
    const seen = Object.create(null);
    if (text[state.index] === '}') {
      state.index += 1;
      return;
    }
    while (state.index < text.length) {
      const key = parseJsonStringToken(text, state);
      if (seen[key] === true) invalidManifest();
      seen[key] = true;
      skipWhitespace(text, state);
      if (text[state.index] !== ':') invalidManifest();
      state.index += 1;
      parseJsonValue(text, state, depth + 1);
      skipWhitespace(text, state);
      if (text[state.index] === '}') {
        state.index += 1;
        return;
      }
      if (text[state.index] !== ',') invalidManifest();
      state.index += 1;
      skipWhitespace(text, state);
    }
    invalidManifest();
  }
  if (token === '[') {
    state.index += 1;
    skipWhitespace(text, state);
    if (text[state.index] === ']') {
      state.index += 1;
      return;
    }
    while (state.index < text.length) {
      parseJsonValue(text, state, depth + 1);
      skipWhitespace(text, state);
      if (text[state.index] === ']') {
        state.index += 1;
        return;
      }
      if (text[state.index] !== ',') invalidManifest();
      state.index += 1;
    }
    invalidManifest();
  }
  if (slice(text, state.index, state.index + 4) === 'true'
    || slice(text, state.index, state.index + 4) === 'null') {
    state.index += 4;
    return;
  }
  if (slice(text, state.index, state.index + 5) === 'false') {
    state.index += 5;
    return;
  }
  parseJsonNumber(text, state);
}

function parseStrictJson(text, expectedKind) {
  if (typeof text !== 'string' || byteLength(text) > MAX_STRING_BYTES) invalidManifest();
  const state = { index: 0 };
  parseJsonValue(text, state, 0);
  skipWhitespace(text, state);
  if (state.index !== text.length) invalidManifest();
  let value;
  try {
    value = JSON_PARSE(text);
  } catch {
    invalidManifest();
  }
  if (value === null || typeof value !== 'object' || types.isProxy(value)
    || (expectedKind === 'array') !== arrayIsArray(value)) invalidManifest();
  return value;
}

function assertPortablePath(value) {
  if (value === null) return;
  if (typeof value !== 'string' || byteLength(value) > 2048
    || value.length === 0 || stringTrim(value) !== value || stringIncludes(value, '\\')
    || stringStartsWith(value, '/') || regexpMatches(WINDOWS_DRIVE, value)
    || regexpMatches(URI_SCHEME, value)) invalidManifest();
  const segments = stringSplit(value, '/');
  if (segments.length > 64) invalidManifest();
  for (let index = 0; index < segments.length; index += 1) {
    if (!regexpMatches(PORTABLE_SEGMENT, segments[index])) invalidManifest();
  }
}

function assertPortableUrl(value) {
  if (value === null) return;
  if (typeof value !== 'string' || byteLength(value) > 4096) invalidManifest();
  if (stringStartsWith(value, '/static/')) {
    assertPortablePath(slice(value, 8));
    return;
  }
  assertPortablePath(value);
}

function validateRow(name, row) {
  const definition = LEGACY_RECORD_SPECS[name];
  const descriptors = exactObjectDescriptors(row, definition.columns);
  const integerSet = Object.create(null);
  const numberSet = Object.create(null);
  const pathSet = Object.create(null);
  const urlSet = Object.create(null);
  const forcedNullSet = Object.create(null);
  const forbiddenNonNullSet = Object.create(null);
  for (let index = 0; index < definition.integers.length; index += 1) integerSet[definition.integers[index]] = true;
  for (let index = 0; index < definition.numbers.length; index += 1) numberSet[definition.numbers[index]] = true;
  for (let index = 0; index < definition.paths.length; index += 1) pathSet[definition.paths[index]] = true;
  for (let index = 0; index < definition.urls.length; index += 1) urlSet[definition.urls[index]] = true;
  for (let index = 0; index < definition.forcedNull.length; index += 1) forcedNullSet[definition.forcedNull[index]] = true;
  for (let index = 0; index < definition.forbiddenNonNull.length; index += 1) {
    forbiddenNonNullSet[definition.forbiddenNonNull[index]] = true;
  }
  for (let index = 0; index < definition.columns.length; index += 1) {
    const column = definition.columns[index];
    const value = descriptors[column].value;
    if (forcedNullSet[column] === true || forbiddenNonNullSet[column] === true) {
      if (value !== null) invalidManifest();
      continue;
    }
    if (integerSet[column] === true) {
      if (value !== null && (!NUMBER_IS_SAFE_INTEGER(value) || value < 0)) invalidManifest();
      if ((column === 'id' || (!stringEndsWith(column, '_id') && column !== 'duration')) && value !== null && value < 0) invalidManifest();
      continue;
    }
    if (numberSet[column] === true) {
      if (value !== null && (typeof value !== 'number' || !NUMBER_IS_FINITE(value)
        || (column === 'emotion_intensity' ? value < -1 || value > 3 : value < 0))) invalidManifest();
      continue;
    }
    if (pathSet[column] === true) {
      assertPortablePath(value);
      continue;
    }
    if (urlSet[column] === true) {
      assertPortableUrl(value);
      continue;
    }
    if (definition.json[column]) {
      if (value !== null && (typeof value !== 'object' || types.isProxy(value)
        || (definition.json[column] === 'array') !== arrayIsArray(value))) invalidManifest();
      continue;
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') invalidManifest();
    if (typeof value === 'string') {
      assertWellFormedString(value);
      if (byteLength(value) > MAX_STRING_BYTES) invalidManifest();
    }
  }
  if (descriptors.id && (!NUMBER_IS_SAFE_INTEGER(descriptors.id.value) || descriptors.id.value <= 0)) invalidManifest();
  if (descriptors.uid && (typeof descriptors.uid.value !== 'string' || !regexpMatches(UUID_V4, descriptors.uid.value))) invalidManifest();
  if (descriptors.deleted_at && descriptors.deleted_at.value !== null) invalidManifest();
  const portable = projectProjectArchiveV21PortableField('canvas_nodes', 'config_json', row);
  if (portable.marker_count !== 0 || portable.binding_state !== 'not_required') secretDetected();
  assertPortableStringsWellFormed(portable.portable_value);
  return portableJsonByteLength(portable.portable_value);
}

function rowIdentity(definition, row) {
  const values = new Array(definition.order.length);
  for (let index = 0; index < definition.order.length; index += 1) values[index] = row[definition.order[index]];
  return values;
}

function compareIdentity(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function indexBy(rows, field) {
  const index = Object.create(null);
  for (let offset = 0; offset < rows.length; offset += 1) {
    const key = STRING_CONSTRUCTOR(rows[offset][field]);
    if (index[key] !== undefined) invalidManifest();
    index[key] = rows[offset];
  }
  return index;
}

function requireRow(index, value) {
  if (value === null || index[STRING_CONSTRUCTOR(value)] === undefined) invalidManifest();
  return index[STRING_CONSTRUCTOR(value)];
}

function optionalRow(index, value) {
  if (value === null) return null;
  return requireRow(index, value);
}

function sourceMatches(rows, sourceId) {
  if (typeof sourceId !== 'string') return false;
  for (let index = 0; index < rows.length; index += 1) {
    if (sourceId === STRING_CONSTRUCTOR(rows[index].id) || sourceId === rows[index].uid) return true;
  }
  return false;
}

function assertReferences(records, dramaUid) {
  if (records.dramas.length !== 1 || records.dramas[0].uid !== dramaUid) invalidManifest();
  const drama = records.dramas[0];
  const dramaId = drama.id;
  const episodes = indexBy(records.episodes, 'id');
  const storyboards = indexBy(records.storyboards, 'id');
  const characters = indexBy(records.characters, 'id');
  const scenes = indexBy(records.scenes, 'id');
  const props = indexBy(records.props, 'id');
  const characterLibraries = indexBy(records.characterLibraries, 'id');
  const images = indexBy(records.imageGenerations, 'id');
  const videos = indexBy(records.videoGenerations, 'id');

  for (let index = 0; index < records.episodes.length; index += 1) {
    if (records.episodes[index].drama_id !== dramaId) invalidManifest();
  }
  for (let index = 0; index < records.characters.length; index += 1) {
    if (records.characters[index].drama_id !== dramaId) invalidManifest();
  }
  for (let index = 0; index < records.scenes.length; index += 1) {
    const row = records.scenes[index];
    if (row.drama_id !== dramaId) invalidManifest();
    optionalRow(episodes, row.episode_id);
  }
  for (let index = 0; index < records.props.length; index += 1) {
    const row = records.props[index];
    if (row.drama_id !== dramaId) invalidManifest();
    optionalRow(episodes, row.episode_id);
  }
  for (let index = 0; index < records.storyboards.length; index += 1) {
    const row = records.storyboards[index];
    requireRow(episodes, row.episode_id);
    optionalRow(scenes, row.scene_id);
    optionalRow(images, row.first_frame_image_id);
    optionalRow(images, row.last_frame_image_id);
  }
  const relationshipKeys = Object.create(null);
  const assertUniquePair = (kind, left, right) => {
    const key = `${kind}:${left}:${right}`;
    if (relationshipKeys[key] === true) invalidManifest();
    relationshipKeys[key] = true;
  };
  for (let index = 0; index < records.episodeCharacters.length; index += 1) {
    const row = records.episodeCharacters[index];
    requireRow(episodes, row.episode_id);
    requireRow(characters, row.character_id);
    assertUniquePair('episode-character', row.episode_id, row.character_id);
  }
  for (let index = 0; index < records.storyboardCharacters.length; index += 1) {
    const row = records.storyboardCharacters[index];
    requireRow(storyboards, row.storyboard_id);
    requireRow(characterLibraries, row.character_id);
    assertUniquePair('storyboard-character', row.storyboard_id, row.character_id);
  }
  for (let index = 0; index < records.storyboardProps.length; index += 1) {
    const row = records.storyboardProps[index];
    requireRow(storyboards, row.storyboard_id);
    requireRow(props, row.prop_id);
    assertUniquePair('storyboard-prop', row.storyboard_id, row.prop_id);
  }
  for (let index = 0; index < records.framePrompts.length; index += 1) {
    requireRow(storyboards, records.framePrompts[index].storyboard_id);
  }
  const referencedCharacterLibraries = Object.create(null);
  for (let index = 0; index < records.storyboardCharacters.length; index += 1) {
    referencedCharacterLibraries[STRING_CONSTRUCTOR(records.storyboardCharacters[index].character_id)] = true;
  }
  for (let index = 0; index < records.characterLibraries.length; index += 1) {
    const row = records.characterLibraries[index];
    if (row.drama_id === dramaId) continue;
    if (row.drama_id === null && referencedCharacterLibraries[STRING_CONSTRUCTOR(row.id)] === true) continue;
    if (row.drama_id === null && row.source_type === 'character'
      && sourceMatches(records.characters, row.source_id)) continue;
    invalidManifest();
  }
  for (let index = 0; index < records.sceneLibraries.length; index += 1) {
    const row = records.sceneLibraries[index];
    if (row.drama_id === dramaId) continue;
    if (row.drama_id === null && row.source_type === 'scene'
      && sourceMatches(records.scenes, row.source_id)) continue;
    invalidManifest();
  }
  for (let index = 0; index < records.propLibraries.length; index += 1) {
    const row = records.propLibraries[index];
    if (row.drama_id === dramaId) continue;
    if (row.drama_id === null && row.source_type === 'prop'
      && sourceMatches(records.props, row.source_id)) continue;
    invalidManifest();
  }

  for (let index = 0; index < records.imageGenerations.length; index += 1) {
    const row = records.imageGenerations[index];
    let owners = 0;
    if (row.drama_id !== null) { if (row.drama_id !== dramaId) invalidManifest(); owners += 1; }
    if (row.episode_id !== null) { requireRow(episodes, row.episode_id); owners += 1; }
    if (row.storyboard_id !== null) { requireRow(storyboards, row.storyboard_id); owners += 1; }
    if (row.scene_id !== null) { requireRow(scenes, row.scene_id); owners += 1; }
    if (row.character_id !== null) { requireRow(characters, row.character_id); owners += 1; }
    if (owners === 0) invalidManifest();
  }
  for (let index = 0; index < records.videoGenerations.length; index += 1) {
    const row = records.videoGenerations[index];
    let owners = 0;
    if (row.drama_id !== null) { if (row.drama_id !== dramaId) invalidManifest(); owners += 1; }
    if (row.storyboard_id !== null) { requireRow(storyboards, row.storyboard_id); owners += 1; }
    if (row.scene_id !== null) { requireRow(scenes, row.scene_id); owners += 1; }
    if (owners === 0) invalidManifest();
  }
  for (let index = 0; index < records.videoMerges.length; index += 1) {
    const row = records.videoMerges[index];
    let owners = 0;
    if (row.drama_id !== null) { if (row.drama_id !== dramaId) invalidManifest(); owners += 1; }
    if (row.episode_id !== null) { requireRow(episodes, row.episode_id); owners += 1; }
    if (owners === 0) invalidManifest();
  }
  for (let index = 0; index < records.legacyAssets.length; index += 1) {
    const row = records.legacyAssets[index];
    let owners = 0;
    if (row.drama_id !== null) { if (row.drama_id !== dramaId) invalidManifest(); owners += 1; }
    if (row.image_gen_id !== null) { requireRow(images, row.image_gen_id); owners += 1; }
    if (row.video_gen_id !== null) { requireRow(videos, row.video_gen_id); owners += 1; }
    if (owners === 0) invalidManifest();
  }
}

function validateProjectLegacyRecords(value, dramaUid) {
  try {
    if (typeof dramaUid !== 'string' || !regexpMatches(UUID_V4, dramaUid)) invalidManifest();
    const names = objectKeys(LEGACY_RECORD_SPECS);
    const root = exactObjectDescriptors(value, names);
    const records = {};
    let recordCount = 0;
    let totalBytes = 0;
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      const name = names[nameIndex];
      const rows = denseArrayValues(root[name].value);
      recordCount += rows.length;
      if (recordCount > MAX_RECORDS) invalidManifest();
      let previous = null;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        totalBytes += validateRow(name, rows[rowIndex]);
        if (totalBytes > MAX_TOTAL_BYTES) invalidManifest();
        const identity = rowIdentity(LEGACY_RECORD_SPECS[name], rows[rowIndex]);
        if (previous !== null && compareIdentity(previous, identity) >= 0) invalidManifest();
        previous = identity;
      }
      records[name] = rows;
    }
    assertReferences(records, dramaUid);
    return value;
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    invalidManifest();
  }
}

function selectColumns(definition) {
  let result = '';
  for (let index = 0; index < definition.columns.length; index += 1) {
    if (index > 0) result += ', ';
    result += `row.${definition.columns[index]}`;
  }
  return result;
}

function orderSql(definition) {
  let result = '';
  for (let index = 0; index < definition.order.length; index += 1) {
    if (index > 0) result += ', ';
    result += `row.${definition.order[index]}`;
  }
  return result;
}

const OWNER_FILTERS = freezeObject({
  dramas: 'row.uid = @dramaUid AND row.deleted_at IS NULL',
  episodes: 'row.drama_id = @dramaId AND row.deleted_at IS NULL',
  characters: 'row.drama_id = @dramaId AND row.deleted_at IS NULL',
  scenes: 'row.drama_id = @dramaId AND row.deleted_at IS NULL',
  props: 'row.drama_id = @dramaId AND row.deleted_at IS NULL',
  storyboards: 'row.deleted_at IS NULL AND EXISTS (SELECT 1 FROM episodes AS owner WHERE owner.id=row.episode_id AND owner.drama_id=@dramaId AND owner.deleted_at IS NULL)',
  episodeCharacters: 'EXISTS (SELECT 1 FROM episodes AS owner WHERE owner.id=row.episode_id AND owner.drama_id=@dramaId AND owner.deleted_at IS NULL)',
  storyboardCharacters: 'EXISTS (SELECT 1 FROM storyboards AS board JOIN episodes AS owner ON owner.id=board.episode_id WHERE board.id=row.storyboard_id AND board.deleted_at IS NULL AND owner.drama_id=@dramaId AND owner.deleted_at IS NULL)',
  storyboardProps: 'EXISTS (SELECT 1 FROM storyboards AS board JOIN episodes AS owner ON owner.id=board.episode_id WHERE board.id=row.storyboard_id AND board.deleted_at IS NULL AND owner.drama_id=@dramaId AND owner.deleted_at IS NULL)',
  characterLibraries: `row.deleted_at IS NULL AND (
    row.drama_id=@dramaId
    OR EXISTS (SELECT 1 FROM storyboard_characters AS link JOIN storyboards AS board ON board.id=link.storyboard_id JOIN episodes AS owner ON owner.id=board.episode_id WHERE link.character_id=row.id AND board.deleted_at IS NULL AND owner.drama_id=@dramaId AND owner.deleted_at IS NULL)
    OR (row.drama_id IS NULL AND row.source_type='character' AND EXISTS (SELECT 1 FROM characters AS owner WHERE owner.drama_id=@dramaId AND owner.deleted_at IS NULL AND (row.source_id=CAST(owner.id AS TEXT) OR row.source_id=owner.uid)))
  )`,
  sceneLibraries: `row.deleted_at IS NULL AND (row.drama_id=@dramaId OR (row.drama_id IS NULL AND row.source_type='scene' AND EXISTS (SELECT 1 FROM scenes AS owner WHERE owner.drama_id=@dramaId AND owner.deleted_at IS NULL AND (row.source_id=CAST(owner.id AS TEXT) OR row.source_id=owner.uid))))`,
  propLibraries: `row.deleted_at IS NULL AND (row.drama_id=@dramaId OR (row.drama_id IS NULL AND row.source_type='prop' AND EXISTS (SELECT 1 FROM props AS owner WHERE owner.drama_id=@dramaId AND owner.deleted_at IS NULL AND (row.source_id=CAST(owner.id AS TEXT) OR row.source_id=owner.uid))))`,
  legacyAssets: `row.deleted_at IS NULL AND (
    row.drama_id=@dramaId
    OR EXISTS (SELECT 1 FROM image_generations AS image WHERE image.id=row.image_gen_id AND (image.drama_id=@dramaId OR image.episode_id IN (SELECT id FROM episodes WHERE drama_id=@dramaId) OR image.storyboard_id IN (SELECT board.id FROM storyboards AS board JOIN episodes AS episode ON episode.id=board.episode_id WHERE episode.drama_id=@dramaId) OR image.scene_id IN (SELECT id FROM scenes WHERE drama_id=@dramaId) OR image.character_id IN (SELECT id FROM characters WHERE drama_id=@dramaId)))
    OR EXISTS (SELECT 1 FROM video_generations AS video WHERE video.id=row.video_gen_id AND (video.drama_id=@dramaId OR video.storyboard_id IN (SELECT board.id FROM storyboards AS board JOIN episodes AS episode ON episode.id=board.episode_id WHERE episode.drama_id=@dramaId) OR video.scene_id IN (SELECT id FROM scenes WHERE drama_id=@dramaId)))
  )`,
  framePrompts: 'EXISTS (SELECT 1 FROM storyboards AS board JOIN episodes AS owner ON owner.id=board.episode_id WHERE board.id=row.storyboard_id AND board.deleted_at IS NULL AND owner.drama_id=@dramaId AND owner.deleted_at IS NULL)',
  imageGenerations: `row.deleted_at IS NULL AND (row.drama_id=@dramaId OR row.episode_id IN (SELECT id FROM episodes WHERE drama_id=@dramaId) OR row.storyboard_id IN (SELECT board.id FROM storyboards AS board JOIN episodes AS episode ON episode.id=board.episode_id WHERE episode.drama_id=@dramaId) OR row.scene_id IN (SELECT id FROM scenes WHERE drama_id=@dramaId) OR row.character_id IN (SELECT id FROM characters WHERE drama_id=@dramaId))`,
  videoGenerations: `row.deleted_at IS NULL AND (row.drama_id=@dramaId OR row.storyboard_id IN (SELECT board.id FROM storyboards AS board JOIN episodes AS episode ON episode.id=board.episode_id WHERE episode.drama_id=@dramaId) OR row.scene_id IN (SELECT id FROM scenes WHERE drama_id=@dramaId))`,
  videoMerges: 'row.deleted_at IS NULL AND (row.drama_id=@dramaId OR row.episode_id IN (SELECT id FROM episodes WHERE drama_id=@dramaId))',
});

function parseRow(name, row) {
  const definition = LEGACY_RECORD_SPECS[name];
  const rawPortable = projectProjectArchiveV21PortableField('canvas_nodes', 'config_json', row);
  if (rawPortable.marker_count !== 0 || rawPortable.binding_state !== 'not_required') secretDetected();
  const record = {};
  const forcedNull = Object.create(null);
  const forbiddenNonNull = Object.create(null);
  const paths = Object.create(null);
  const urls = Object.create(null);
  for (let index = 0; index < definition.forcedNull.length; index += 1) forcedNull[definition.forcedNull[index]] = true;
  for (let index = 0; index < definition.forbiddenNonNull.length; index += 1) {
    forbiddenNonNull[definition.forbiddenNonNull[index]] = true;
  }
  for (let index = 0; index < definition.paths.length; index += 1) paths[definition.paths[index]] = true;
  for (let index = 0; index < definition.urls.length; index += 1) urls[definition.urls[index]] = true;
  for (let index = 0; index < definition.columns.length; index += 1) {
    const column = definition.columns[index];
    if (forbiddenNonNull[column] === true && row[column] !== null) invalidManifest();
    let value = forcedNull[column] === true ? null : row[column];
    if ((paths[column] === true || urls[column] === true) && value === '') value = null;
    if (definition.json[column]) {
      if (value === null || value === '') value = null;
      else value = parseStrictJson(value, definition.json[column]);
    }
    record[column] = value;
  }
  return record;
}

function deepFreeze(value) {
  const stack = [value];
  let cursor = 0;
  while (cursor < stack.length) {
    const current = stack[cursor];
    cursor += 1;
    if (current === null || typeof current !== 'object'
      || REFLECT_APPLY(OBJECT_IS_FROZEN, Object, [current])) continue;
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [current]);
    const keys = REFLECT_OWN_KEYS(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]];
      if (hasOwn(descriptor, 'value') && descriptor.value !== null && typeof descriptor.value === 'object') {
        stack[stack.length] = descriptor.value;
      }
    }
    REFLECT_APPLY(OBJECT_FREEZE, Object, [current]);
  }
  return value;
}

function createProjectArchiveV21LegacyData(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('Project archive legacy data database is invalid');
  }
  const dramaByUid = database.prepare(
    'SELECT id, uid FROM dramas WHERE uid=? AND deleted_at IS NULL',
  );
  const names = objectKeys(LEGACY_RECORD_SPECS);
  const statements = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const definition = LEGACY_RECORD_SPECS[name];
    statements[name] = database.prepare(`
      SELECT ${selectColumns(definition)}
      FROM ${definition.table} AS row
      WHERE ${OWNER_FILTERS[name]}
      ORDER BY ${orderSql(definition)}
    `);
  }
  freezeObject(statements);
  return freezeObject({
    exportForDrama(dramaUid) {
      try {
        if (typeof dramaUid !== 'string' || !regexpMatches(UUID_V4, dramaUid)) invalidManifest();
        const drama = dramaByUid.get(dramaUid);
        if (!drama) invalidManifest();
        const records = {};
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          const rows = statements[name].all({ dramaUid, dramaId: drama.id });
          const parsed = new Array(rows.length);
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            parsed[rowIndex] = parseRow(name, rows[rowIndex]);
          }
          records[name] = parsed;
        }
        validateProjectLegacyRecords(records, dramaUid);
        return deepFreeze(records);
      } catch (error) {
        if (isProjectArchiveError(error)) throw error;
        invalidManifest();
      }
    },
  });
}

const expectedTables = new Array(
  PROJECT_ARCHIVE_CATALOG.legacyCoreTables.length + PROJECT_ARCHIVE_CATALOG.legacyAddendumTables.length,
);
let expectedIndex = 0;
for (let index = 0; index < PROJECT_ARCHIVE_CATALOG.legacyCoreTables.length; index += 1) {
  expectedTables[expectedIndex] = PROJECT_ARCHIVE_CATALOG.legacyCoreTables[index];
  expectedIndex += 1;
}
for (let index = 0; index < PROJECT_ARCHIVE_CATALOG.legacyAddendumTables.length; index += 1) {
  expectedTables[expectedIndex] = PROJECT_ARCHIVE_CATALOG.legacyAddendumTables[index];
  expectedIndex += 1;
}
REFLECT_APPLY(ARRAY_SORT, expectedTables, []);
const actualTables = new Array(objectKeys(LEGACY_RECORD_SPECS).length);
const actualNames = objectKeys(LEGACY_RECORD_SPECS);
for (let index = 0; index < actualNames.length; index += 1) {
  actualTables[index] = LEGACY_RECORD_SPECS[actualNames[index]].table;
}
REFLECT_APPLY(ARRAY_SORT, actualTables, []);
if (expectedTables.length !== actualTables.length) throw new TypeError('Legacy archive catalog is incomplete');
for (let index = 0; index < expectedTables.length; index += 1) {
  if (expectedTables[index] !== actualTables[index]) throw new TypeError('Legacy archive catalog is incomplete');
}

module.exports = freezeObject({
  LEGACY_RECORD_SPECS,
  createProjectArchiveV21LegacyData,
  validateProjectLegacyRecords,
});
