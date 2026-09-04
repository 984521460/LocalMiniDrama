'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const {
  inspectSourceTextFile,
} = require('../backend-node/src/narrative/sourceImport');

const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'sourceId', 'title', 'language', 'sourceFile', 'sourceType',
  'encoding', 'contentSha256', 'licenseFile', 'licenseSha256', 'selection',
  'encodingProbe',
]);
const SELECTION_KEYS = Object.freeze([
  'startText', 'endText', 'startCodePoint', 'endCodePoint',
  'selectedCodePointLength', 'selectedTextSha256', 'expectedHeadingPath',
  'targetNarrativeDurationSeconds',
]);
const ENCODING_PROBE_KEYS = Object.freeze([
  'fileName', 'bytesHex', 'expectedOptions', 'selectedEncoding', 'decodedTextSha256',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/u;
const HEX = /^(?:[0-9a-f]{2})+$/u;
const ERROR_CODE = 'MVP_BENCHMARK_SOURCE_INVALID';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_LICENSE_BYTES = 32 * 1024;

class MvpBenchmarkSourceError extends Error {
  constructor() {
    super('MVP benchmark source pack is invalid');
    this.name = 'MvpBenchmarkSourceError';
    this.code = ERROR_CODE;
    Object.freeze(this);
  }
}

function fail() {
  throw new MvpBenchmarkSourceError();
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) fail();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!Object.hasOwn(descriptors, key)) fail();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  return output;
}

function denseStrings(value, minimum, maximum) {
  if (!Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(descriptors, 'length')
    || !Object.hasOwn(descriptors.length, 'value')) fail();
  const length = descriptors.length.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) fail();
  const output = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!Object.hasOwn(descriptors, key)) fail();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string') fail();
    output[index] = descriptor.value;
  }
  return Object.freeze(output);
}

function text(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
    || Buffer.byteLength(value, 'utf8') > maximum || value.trim() !== value) fail();
  return value;
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function sha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail();
  return value;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotBuffer(value, maximum) {
  if (!Buffer.isBuffer(value) || isProxy(value) || value.length < 1 || value.length > maximum) {
    fail();
  }
  return Buffer.from(value);
}

function occurrence(textValue, marker) {
  const first = textValue.indexOf(marker);
  if (first < 0 || textValue.lastIndexOf(marker) !== first) fail();
  return first;
}

function headingPathAt(textValue, offset) {
  const prefix = textValue.slice(0, offset);
  const lines = prefix.split('\n');
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(lines[index]);
    if (!match) continue;
    const level = match[1].length;
    headings.length = level - 1;
    headings[level - 1] = match[2];
  }
  return Object.freeze(headings.filter((value) => typeof value === 'string'));
}

function validateMvpBenchmarkSourceArtifacts(value) {
  const input = exactObject(value, ['manifest', 'sourceBytes', 'licenseBytes']);
  const manifestInput = exactObject(input.manifest, MANIFEST_KEYS);
  const selectionInput = exactObject(manifestInput.selection, SELECTION_KEYS);
  const probeInput = exactObject(manifestInput.encodingProbe, ENCODING_PROBE_KEYS);
  const expectedHeadingPath = denseStrings(selectionInput.expectedHeadingPath, 1, 6);
  const expectedOptions = denseStrings(probeInput.expectedOptions, 1, 3);
  const sourceBytes = snapshotBuffer(input.sourceBytes, MAX_SOURCE_BYTES);
  const licenseBytes = snapshotBuffer(input.licenseBytes, MAX_LICENSE_BYTES);

  const manifest = Object.freeze({
    schemaVersion: manifestInput.schemaVersion,
    sourceId: manifestInput.sourceId,
    title: manifestInput.title,
    language: manifestInput.language,
    sourceFile: manifestInput.sourceFile,
    sourceType: manifestInput.sourceType,
    encoding: manifestInput.encoding,
    contentSha256: manifestInput.contentSha256,
    licenseFile: manifestInput.licenseFile,
    licenseSha256: manifestInput.licenseSha256,
    selection: Object.freeze({
      startText: selectionInput.startText,
      endText: selectionInput.endText,
      startCodePoint: selectionInput.startCodePoint,
      endCodePoint: selectionInput.endCodePoint,
      selectedCodePointLength: selectionInput.selectedCodePointLength,
      selectedTextSha256: selectionInput.selectedTextSha256,
      expectedHeadingPath,
      targetNarrativeDurationSeconds: selectionInput.targetNarrativeDurationSeconds,
    }),
    encodingProbe: Object.freeze({
      fileName: probeInput.fileName,
      bytesHex: probeInput.bytesHex,
      expectedOptions,
      selectedEncoding: probeInput.selectedEncoding,
      decodedTextSha256: probeInput.decodedTextSha256,
    }),
  });

  if (manifest.schemaVersion !== 'mvp-benchmark-source.v1'
    || typeof manifest.sourceId !== 'string' || !SOURCE_ID.test(manifest.sourceId)
    || text(manifest.title, 1, 128) !== '雨停之前'
    || manifest.language !== 'zh-CN'
    || manifest.sourceFile !== 'source.md' || manifest.sourceType !== 'markdown'
    || manifest.encoding !== 'utf-8' || manifest.licenseFile !== 'LICENSE.md'
    || sha256(manifest.contentSha256) !== hash(sourceBytes)
    || sha256(manifest.licenseSha256) !== hash(licenseBytes)) fail();

  const inspected = inspectSourceTextFile({
    fileName: manifest.sourceFile,
    bytes: sourceBytes,
    encoding: manifest.encoding,
  });
  if (inspected.status !== 'ready' || inspected.contentSha256 !== manifest.contentSha256
    || inspected.sourceType !== manifest.sourceType || inspected.encoding !== manifest.encoding) fail();
  const sourceText = inspected.text;
  const startText = text(manifest.selection.startText, 1, 256);
  const endText = text(manifest.selection.endText, 1, 256);
  const startUnit = occurrence(sourceText, startText);
  const endUnit = occurrence(sourceText, endText) + endText.length;
  if (endUnit <= startUnit) fail();
  const selectedText = sourceText.slice(startUnit, endUnit);
  const startCodePoint = Array.from(sourceText.slice(0, startUnit)).length;
  const endCodePoint = Array.from(sourceText.slice(0, endUnit)).length;
  const selectedCodePointLength = Array.from(selectedText).length;
  if (integer(manifest.selection.startCodePoint, 0, 131072) !== startCodePoint
    || integer(manifest.selection.endCodePoint, 1, 131072) !== endCodePoint
    || integer(manifest.selection.selectedCodePointLength, 1, 131072)
      !== selectedCodePointLength
    || selectedCodePointLength !== endCodePoint - startCodePoint
    || sha256(manifest.selection.selectedTextSha256)
      !== hash(Buffer.from(selectedText, 'utf8'))
    || integer(manifest.selection.targetNarrativeDurationSeconds, 60, 60) !== 60) fail();
  const actualHeadingPath = headingPathAt(sourceText, startUnit);
  if (actualHeadingPath.length !== expectedHeadingPath.length) fail();
  for (let index = 0; index < actualHeadingPath.length; index += 1) {
    if (actualHeadingPath[index] !== expectedHeadingPath[index]) fail();
  }

  text(manifest.encodingProbe.fileName, 1, 128);
  if (manifest.encodingProbe.fileName !== 'encoding-choice.txt'
    || typeof manifest.encodingProbe.bytesHex !== 'string'
    || manifest.encodingProbe.bytesHex.length > 4096
    || !HEX.test(manifest.encodingProbe.bytesHex)
    || manifest.encodingProbe.selectedEncoding !== 'gbk') fail();
  const probeBytes = Buffer.from(manifest.encodingProbe.bytesHex, 'hex');
  const pending = inspectSourceTextFile({
    fileName: manifest.encodingProbe.fileName,
    bytes: probeBytes,
  });
  if (pending.status !== 'encoding_required'
    || pending.encodingOptions.length !== expectedOptions.length) fail();
  for (let index = 0; index < expectedOptions.length; index += 1) {
    if (pending.encodingOptions[index] !== expectedOptions[index]) fail();
  }
  const decoded = inspectSourceTextFile({
    fileName: manifest.encodingProbe.fileName,
    bytes: probeBytes,
    encoding: manifest.encodingProbe.selectedEncoding,
  });
  if (decoded.status !== 'ready'
    || sha256(manifest.encodingProbe.decodedTextSha256) !== decoded.normalizedTextSha256) fail();

  const licenseText = licenseBytes.toString('utf8');
  if (!licenseText.includes('original synthetic story')
    || !licenseText.includes("repository's MIT License")
    || licenseText.includes('\u0000')) fail();

  return Object.freeze({
    manifest,
    sourceBytes: Buffer.from(sourceBytes),
    licenseBytes: Buffer.from(licenseBytes),
    sourceText,
    selectedText,
    licenseText,
  });
}

function validateMvpBenchmarkSourcePack(root) {
  if (typeof root !== 'string' || root.length < 1 || root.length > 4096) fail();
  const resolved = path.resolve(root);
  let rootStat;
  let rootRealPath;
  try {
    rootStat = fs.lstatSync(resolved, { bigint: true });
    rootRealPath = fs.realpathSync.native(resolved);
  } catch {
    fail();
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootRealPath !== resolved) fail();
  function readExact(fileName, maximum) {
    const filename = path.join(resolved, fileName);
    let stat;
    let realPath;
    try {
      stat = fs.lstatSync(filename, { bigint: true });
      realPath = fs.realpathSync.native(filename);
    } catch {
      fail();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || stat.size < 1n || stat.size > BigInt(maximum) || realPath !== filename) fail();
    return fs.readFileSync(filename);
  }
  const manifestBytes = readExact('manifest.json', MAX_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail();
  }
  const result = validateMvpBenchmarkSourceArtifacts({
    manifest,
    sourceBytes: readExact('source.md', MAX_SOURCE_BYTES),
    licenseBytes: readExact('LICENSE.md', MAX_LICENSE_BYTES),
  });
  if (manifestBytes.toString('utf8') !== `${JSON.stringify(result.manifest, null, 2)}\n`) fail();
  return result;
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '../benchmarks/mvp-source');
    const result = validateMvpBenchmarkSourcePack(root);
    process.stdout.write(`${JSON.stringify({
      status: 'MVP_BENCHMARK_SOURCE_VERIFIED',
      sourceId: result.manifest.sourceId,
      contentSha256: result.manifest.contentSha256,
      selectedTextSha256: result.manifest.selection.selectedTextSha256,
      licenseSha256: result.manifest.licenseSha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error?.code === ERROR_CODE ? ERROR_CODE : ERROR_CODE,
      message: 'MVP benchmark source verification failed',
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ERROR_CODE,
  MvpBenchmarkSourceError,
  validateMvpBenchmarkSourceArtifacts,
  validateMvpBenchmarkSourcePack,
});
