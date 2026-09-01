'use strict';

const { types: { isProxy } } = require('node:util');

const aiClient = require('../../services/aiClient');

const MAX_PROMPT_BYTES = 1024 * 1024;
// The provider payload is capped at 4 MiB after SSE/JSON decoding. The transport
// budget must also cover JSON string escaping and framing without making that
// valid domain boundary unreachable.
const MAX_TRANSPORT_RESPONSE_BYTES = 16 * 1024 * 1024;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const JSON_STRINGIFY = JSON.stringify;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const TASKS = Object.freeze({
  extraction: Object.freeze({
    promptVersion: 'narrative-extraction.v1',
    sceneKey: 'narrative_extraction',
    schema: require('../../../../schemas/v3/novel-extraction.schema.json'),
  }),
  adaptation: Object.freeze({
    promptVersion: 'narrative-adaptation.v1',
    sceneKey: 'narrative_adaptation',
    schema: require('../../../../schemas/v3/episode-adaptation.schema.json'),
  }),
  script: Object.freeze({
    promptVersion: 'narrative-script.v1',
    sceneKey: 'narrative_script',
    schema: require('../../../../schemas/v3/script-formatting.schema.json'),
  }),
  shot: Object.freeze({
    promptVersion: 'narrative-shot.v1',
    sceneKey: 'narrative_shot',
    schema: require('../../../../schemas/v3/shot-planning.schema.json'),
  }),
});

function exactCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Narrative generation command is invalid');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('Narrative generation command is invalid');
  }
  const keys = ['schemaVersion', 'resultType', 'source', 'domain'];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) {
    throw new TypeError('Narrative generation command is invalid');
  }
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new TypeError('Narrative generation command is invalid');
    }
    output[key] = descriptor.value;
  }
  if (output.schemaVersion !== 'narrative-generation-command.v1'
    || !OBJECT_HAS_OWN(TASKS, output.resultType)
    || (output.resultType === 'extraction') !== (output.domain === null)) {
    throw new TypeError('Narrative generation command is invalid');
  }
  return output;
}

function boundedJsonBytes(value, remaining, seen = new WeakSet(), depth = 0) {
  if (remaining < 0 || depth > 64) return -1;
  if (value === null) return remaining - 4;
  if (typeof value === 'boolean') return remaining - (value ? 4 : 5);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return -1;
    return remaining - String(value).length;
  }
  if (typeof value === 'string') {
    if (value.length > remaining) return -1;
    return remaining - Buffer.byteLength(value, 'utf8') - 2;
  }
  if (!value || typeof value !== 'object' || isProxy(value) || seen.has(value)) return -1;
  let prototype;
  let descriptors;
  try {
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    return -1;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return -1;
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0
      || REFLECT_OWN_KEYS(descriptors).length !== length + 1) return -1;
    remaining -= 2 + Math.max(0, length - 1);
    for (let index = 0; index < length && remaining >= 0; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) return -1;
      remaining = boundedJsonBytes(descriptor.value, remaining, seen, depth + 1);
    }
    seen.delete(value);
    return remaining;
  }
  if (prototype !== Object.prototype && prototype !== null) return -1;
  const keys = REFLECT_OWN_KEYS(descriptors);
  remaining -= 2 + Math.max(0, keys.length - 1);
  for (let index = 0; index < keys.length && remaining >= 0; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !OBJECT_HAS_OWN(descriptor, 'value') || key.length > remaining) return -1;
    remaining -= Buffer.byteLength(key, 'utf8') + 3;
    remaining = boundedJsonBytes(descriptor.value, remaining, seen, depth + 1);
  }
  seen.delete(value);
  return remaining;
}

function serializeJsonData(value, seen = new WeakSet(), depth = 0) {
  if (depth > 64) throw new TypeError('Narrative generation prompt is invalid');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number') {
    return Reflect.apply(JSON_STRINGIFY, JSON, [value]);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!value || typeof value !== 'object' || isProxy(value) || seen.has(value)) {
    throw new TypeError('Narrative generation prompt is invalid');
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 0
        || REFLECT_OWN_KEYS(descriptors).length !== length + 1) {
        throw new TypeError('Narrative generation prompt is invalid');
      }
      let output = '[';
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !OBJECT_HAS_OWN(descriptor, 'value')) {
          throw new TypeError('Narrative generation prompt is invalid');
        }
        if (index > 0) output += ',';
        output += serializeJsonData(descriptor.value, seen, depth + 1);
      }
      return `${output}]`;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Narrative generation prompt is invalid');
    }
    const keys = REFLECT_OWN_KEYS(descriptors);
    let output = '{';
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor?.enumerable
        || !OBJECT_HAS_OWN(descriptor, 'value')) {
        throw new TypeError('Narrative generation prompt is invalid');
      }
      if (index > 0) output += ',';
      output += `${Reflect.apply(JSON_STRINGIFY, JSON, [key])}:${serializeJsonData(
        descriptor.value,
        seen,
        depth + 1,
      )}`;
    }
    return `${output}}`;
  } finally {
    seen.delete(value);
  }
}

function createConfiguredNarrativeTextProvider({ database, log, dependencies = {} } = {}) {
  const generateText = dependencies.generateText || aiClient.generateText;
  const getMapped = dependencies.getConfigFromModelMap || aiClient.getConfigFromModelMap;
  const getDefault = dependencies.getDefaultConfig || aiClient.getDefaultConfig;
  if (!database || typeof database.prepare !== 'function' || !log
    || typeof generateText !== 'function' || typeof getMapped !== 'function'
    || typeof getDefault !== 'function') {
    throw new TypeError('Configured narrative provider dependencies are invalid');
  }
  return Object.freeze({
    scope: 'configured-text',
    isAvailable() {
      try {
        return database.prepare(`
          SELECT 1 AS available
          FROM ai_service_configs
          WHERE service_type='text' AND deleted_at IS NULL AND is_active=1
          LIMIT 1
        `).get()?.available === 1;
      } catch {
        return false;
      }
    },
    generate(value) {
      const command = exactCommand(value);
      const task = TASKS[command.resultType];
      const routed = getMapped(database, task.sceneKey);
      if (!routed?.config && !getDefault(database, 'text')) {
        throw new TypeError('Configured narrative provider is unavailable');
      }
      const source = command.resultType === 'extraction'
        ? { source: command.source } : { domain: command.domain };
      const prompt = {
        task: command.resultType,
        input: source,
        outputSchema: task.schema,
      };
      if (boundedJsonBytes(prompt, MAX_PROMPT_BYTES) < 0) {
        throw new TypeError('Narrative generation prompt exceeds the local bound');
      }
      const userPrompt = serializeJsonData(prompt);
      if (Buffer.byteLength(userPrompt, 'utf8') > MAX_PROMPT_BYTES) {
        throw new TypeError('Narrative generation prompt exceeds the local bound');
      }
      const systemPrompt = [
        'You are the structured narrative production engine for LocalMiniDrama.',
        'Return exactly one JSON object that conforms to outputSchema.',
        'Do not add Markdown, explanations, hidden fields, or facts unsupported by input.',
        'Preserve evidence references and all identifier spellings exactly.',
      ].join(' ');
      return generateText(database, log, 'text', userPrompt, systemPrompt, {
        scene_key: task.sceneKey,
        temperature: 0,
        json_mode: true,
        min_max_tokens: 8192,
        return_metadata: true,
        prompt_version: task.promptVersion,
        max_response_bytes: MAX_TRANSPORT_RESPONSE_BYTES,
      });
    },
  });
}

module.exports = Object.freeze({ createConfiguredNarrativeTextProvider });
