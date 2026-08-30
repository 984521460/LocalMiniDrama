'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DISTRIBUTION_ASSET_ERROR = 'DISTRIBUTION_ASSET_CONTRACT_INVALID';
const MODEL_WEIGHT_EXTENSIONS = Object.freeze(new Set([
  '.ckpt',
  '.gguf',
  '.onnx',
  '.pt',
  '.pth',
  '.safetensors',
  '.tflite',
]));
const MAX_SCANNED_FILES = 100_000;
const EXPECTED_EXTRA_RESOURCES = Object.freeze([
  Object.freeze({ from: 'frontweb-dist', to: 'frontweb/dist', filter: Object.freeze(['**/*']) }),
  Object.freeze({ from: '../LICENSE', to: 'licenses/LICENSE' }),
  Object.freeze({ from: '../THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md' }),
]);

class DistributionAssetContractError extends Error {
  constructor() {
    super('Distribution asset contract invalid');
    this.name = 'DistributionAssetContractError';
    this.code = DISTRIBUTION_ASSET_ERROR;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function invalid() {
  throw new DistributionAssetContractError();
}

function normalizedArchiveEntry(value) {
  if (typeof value !== 'string' || value.includes('\0')) invalid();
  return `/${value.replaceAll('\\', '/').replace(/^\/+/, '')}`.toLowerCase();
}

function isModelWeightPath(value) {
  const normalized = normalizedArchiveEntry(value);
  if (MODEL_WEIGHT_EXTENSIONS.has(path.posix.extname(normalized))) return true;
  const basename = path.posix.basename(normalized);
  if (/^(?:diffusion_pytorch_model|model|pytorch_model|weights)\.(?:bin|pb)$/u.test(basename)) {
    return true;
  }
  return /\/(?:checkpoints?|loras?|models?)\/[^/]+\.(?:bin|pb)$/u.test(normalized);
}

function isForbiddenDistributionPath(value) {
  const normalized = normalizedArchiveEntry(value);
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) || '';
  if (basename === 'ffmpeg' || basename === 'ffprobe'
    || basename === 'ffmpeg.exe' || basename === 'ffprobe.exe') return true;
  return segments.includes('example_drama') || segments.includes('ffmpeg');
}

function assertDistributionBuildConfig(packageOrBuild) {
  if (!packageOrBuild || typeof packageOrBuild !== 'object' || Array.isArray(packageOrBuild)) invalid();
  const build = packageOrBuild.build ?? packageOrBuild;
  if (!build || typeof build !== 'object' || Array.isArray(build)) invalid();
  if (!Array.isArray(build.files)) invalid();
  for (const required of ['main.js', 'distribution-assets.js', 'windows-release-contract.js']) {
    if (!build.files.includes(required)) invalid();
  }
  const resources = build.extraResources;
  if (!Array.isArray(resources) || resources.length !== EXPECTED_EXTRA_RESOURCES.length) invalid();
  for (let index = 0; index < EXPECTED_EXTRA_RESOURCES.length; index += 1) {
    const resource = resources[index];
    const expected = EXPECTED_EXTRA_RESOURCES[index];
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) invalid();
    if (resource.from !== expected.from || resource.to !== expected.to) invalid();
    if (expected.filter) {
      if (!Array.isArray(resource.filter)
        || resource.filter.length !== 1
        || resource.filter[0] !== expected.filter[0]) invalid();
    } else if (resource.filter !== undefined) invalid();
    const keys = Object.keys(resource).sort();
    const expectedKeys = expected.filter ? ['filter', 'from', 'to'] : ['from', 'to'];
    if (keys.length !== expectedKeys.length
      || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) invalid();
  }
  return Object.freeze({ extraResourceCount: EXPECTED_EXTRA_RESOURCES.length });
}

function assertArchiveDistributionEntries(entries) {
  if (!Array.isArray(entries)) invalid();
  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(entries, index)) invalid();
    const normalized = normalizedArchiveEntry(entries[index]);
    if (isForbiddenDistributionPath(normalized) || isModelWeightPath(normalized)) invalid();
  }
  return Object.freeze({ entryCount: entries.length });
}

function assertNoModelWeightFiles(roots, {
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (!Array.isArray(roots)) invalid();
  const pending = roots.slice();
  let fileCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'string' || current.length < 1) invalid();
    if (!fsImpl.existsSync(current)) continue;
    if (isForbiddenDistributionPath(current)) invalid();
    const stat = fsImpl.lstatSync(current);
    if (stat.isSymbolicLink()) invalid();
    if (stat.isDirectory()) {
      const entries = fsImpl.readdirSync(current, { withFileTypes: true });
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.isSymbolicLink()) invalid();
        pending.push(pathImpl.join(current, entry.name));
      }
      continue;
    }
    if (!stat.isFile()) invalid();
    fileCount += 1;
    if (fileCount > MAX_SCANNED_FILES || isModelWeightPath(current)) invalid();
  }
  return Object.freeze({ fileCount });
}

module.exports = Object.freeze({
  DISTRIBUTION_ASSET_ERROR,
  DistributionAssetContractError,
  assertArchiveDistributionEntries,
  assertDistributionBuildConfig,
  assertNoModelWeightFiles,
  isForbiddenDistributionPath,
  isModelWeightPath,
});
