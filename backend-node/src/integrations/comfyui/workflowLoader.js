'use strict';

const crypto = require('node:crypto');

const { snapshotJson } = require('../../workflows/jsonSnapshot');
const { snapshotBuffer } = require('./byteSnapshot');
const { createComfyWorkflowError } = require('./workflowErrors');

const MAX_WORKFLOW_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_ENTRIES = 50000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;

function invalid() {
  return createComfyWorkflowError('COMFY_WORKFLOW_INVALID');
}

function limited() {
  return createComfyWorkflowError('COMFY_WORKFLOW_LIMIT_EXCEEDED');
}

function assertUnambiguousJson(text) {
  let offset = 0;
  let entries = 0;

  function fail() { throw invalid(); }
  function skipWhitespace() {
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return;
      offset += 1;
    }
  }
  function account(depth) {
    if (depth > MAX_DEPTH) throw limited();
    entries += 1;
    if (entries > MAX_ENTRIES) throw limited();
  }
  function parseString(decode = false) {
    if (text[offset] !== '"') fail();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        if (!decode) return undefined;
        try { return JSON.parse(text.slice(start, offset)); } catch { return fail(); }
      }
      if (code < 0x20) fail();
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length || !'"\\/bfnrtu'.includes(text[offset])) fail();
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5))) fail();
          offset += 4;
        }
      }
      offset += 1;
    }
    fail();
    return undefined;
  }
  function parseNumber() {
    NUMBER_TOKEN.lastIndex = offset;
    const match = NUMBER_TOKEN.exec(text);
    if (!match) fail();
    offset += match[0].length;
  }
  function parseArray(depth) {
    offset += 1;
    skipWhitespace();
    if (text[offset] === ']') { offset += 1; return; }
    while (true) {
      account(depth);
      parseValue(depth);
      skipWhitespace();
      if (text[offset] === ']') { offset += 1; return; }
      if (text[offset] !== ',') fail();
      offset += 1;
      skipWhitespace();
    }
  }
  function parseObject(depth) {
    offset += 1;
    skipWhitespace();
    if (text[offset] === '}') { offset += 1; return; }
    const keys = new Set();
    while (true) {
      account(depth);
      const key = parseString(true);
      if (keys.has(key)) fail();
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ':') fail();
      offset += 1;
      skipWhitespace();
      parseValue(depth);
      skipWhitespace();
      if (text[offset] === '}') { offset += 1; return; }
      if (text[offset] !== ',') fail();
      offset += 1;
      skipWhitespace();
    }
  }
  function parseValue(depth = 0) {
    if (depth > MAX_DEPTH) throw limited();
    skipWhitespace();
    const current = text[offset];
    if (current === '{') return parseObject(depth + 1);
    if (current === '[') return parseArray(depth + 1);
    if (current === '"') return parseString(false);
    if (text.startsWith('true', offset)) { offset += 4; return undefined; }
    if (text.startsWith('false', offset)) { offset += 5; return undefined; }
    if (text.startsWith('null', offset)) { offset += 4; return undefined; }
    const code = text.charCodeAt(offset);
    if (current === '-' || (code >= 0x30 && code <= 0x39)) return parseNumber();
    return fail();
  }

  skipWhitespace();
  parseValue(0);
  skipWhitespace();
  if (offset !== text.length) fail();
}

function containsUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertUnicodeScalarStrings(value) {
  if (typeof value === 'string') {
    if (containsUnpairedSurrogate(value)) throw invalid();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertUnicodeScalarStrings(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (containsUnpairedSurrogate(key)) throw invalid();
      assertUnicodeScalarStrings(item);
    }
  }
}

function loadComfyWorkflowJson(value) {
  let bytes;
  try { bytes = snapshotBuffer(value, MAX_WORKFLOW_BYTES, invalid, limited); } catch (error) { throw error; }
  let text;
  try { text = UTF8_DECODER.decode(bytes); } catch { throw invalid(); }
  assertUnambiguousJson(text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  assertUnicodeScalarStrings(parsed);
  let workflow;
  try {
    workflow = snapshotJson(parsed, {
      maxArrayLength: 5000,
      maxDepth: MAX_DEPTH,
      maxEntries: MAX_ENTRIES,
      maxStringBytes: 512 * 1024,
      maxTotalBytes: MAX_WORKFLOW_BYTES,
    });
  } catch (error) {
    if (error?.code === 'STRUCTURED_INPUT_LIMIT_EXCEEDED') throw limited();
    throw invalid();
  }
  if (!workflow || Array.isArray(workflow)) throw invalid();
  return Object.freeze({
    workflow,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  });
}

module.exports = Object.freeze({ MAX_WORKFLOW_BYTES, loadComfyWorkflowJson });
