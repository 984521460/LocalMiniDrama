'use strict';

const {
  canonicalUid,
  exactObject,
  fail,
  safeInteger,
} = require('./environmentValidation');
const { PROFILE } = require('./initializationPlan');

const SUMMARY_KEYS = Object.freeze([
  'platform', 'architecture', 'gpuVendor', 'gpuName', 'gpuCount', 'totalVramMiB',
  'driverVersion', 'systemMemoryMiB', 'diskFreeMiB', 'pythonVersion', 'torchVersion',
  'cudaVersion', 'ffmpegVersion', 'comfyUiVersion', 'comfyUiRevision',
  'workspaceWritable', 'directoriesReady', 'comfyUiReachable',
]);
const PLATFORMS = new Set(['linux']);
const ARCHITECTURES = new Set(['x64', 'arm64']);
const GPU_VENDORS = new Set(['nvidia', 'amd', 'other', 'none']);
const VERSION = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+[0-9a-z.]+)?$/u;

function boolean(value) {
  if (typeof value !== 'boolean') fail();
  return value;
}

function version(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 32 || !VERSION.test(value)) fail();
  return value;
}

function safeLabel(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 128
    || (!allowEmpty && value.length === 0) || !/^[\x20-\x7e]*$/u.test(value)) fail();
  return value;
}

function revision(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail();
  return value;
}

function createEnvironmentReport(value) {
  const input = exactObject(value, ['connectionUid', 'collectedAtEpochMs', 'summary']);
  const summary = exactObject(input.summary, SUMMARY_KEYS);
  if (!PLATFORMS.has(summary.platform) || !ARCHITECTURES.has(summary.architecture)
    || !GPU_VENDORS.has(summary.gpuVendor)) fail();
  const report = {
    contractVersion: 'remote-environment-report.v2',
    connectionUid: canonicalUid(input.connectionUid),
    collectedAtEpochMs: safeInteger(input.collectedAtEpochMs, 0, 8_640_000_000_000_000),
    profileVersion: PROFILE.profileVersion,
    platform: summary.platform,
    architecture: summary.architecture,
    gpuVendor: summary.gpuVendor,
    gpuName: safeLabel(summary.gpuName, true),
    gpuCount: safeInteger(summary.gpuCount, 0, 16),
    totalVramMiB: safeInteger(summary.totalVramMiB, 0, 2_097_152),
    driverVersion: version(summary.driverVersion),
    systemMemoryMiB: safeInteger(summary.systemMemoryMiB, 1, 4_194_304),
    diskFreeMiB: safeInteger(summary.diskFreeMiB, 0, 1_073_741_824),
    pythonVersion: version(summary.pythonVersion),
    torchVersion: version(summary.torchVersion),
    cudaVersion: version(summary.cudaVersion),
    ffmpegVersion: version(summary.ffmpegVersion),
    comfyUiVersion: version(summary.comfyUiVersion),
    comfyUiRevision: revision(summary.comfyUiRevision),
    workspaceWritable: boolean(summary.workspaceWritable),
    directoriesReady: boolean(summary.directoriesReady),
    comfyUiReachable: boolean(summary.comfyUiReachable),
  };
  if ((report.gpuCount === 0) !== (report.gpuVendor === 'none')
    || (report.gpuCount === 0) !== (report.totalVramMiB === 0)) fail();
  report.ready = report.gpuVendor === 'nvidia'
    && report.gpuName === PROFILE.gpuName
    && report.gpuCount === PROFILE.gpuCount
    && report.totalVramMiB === PROFILE.totalVramMiB
    && report.driverVersion === PROFILE.driverVersion
    && report.pythonVersion === PROFILE.pythonVersion
    && report.torchVersion === PROFILE.torchVersion
    && report.cudaVersion === PROFILE.cudaVersion
    && report.ffmpegVersion === PROFILE.ffmpegVersion
    && report.comfyUiVersion === PROFILE.comfyUiVersion
    && report.comfyUiRevision === PROFILE.comfyUiRevision
    && report.workspaceWritable
    && report.directoriesReady
    && report.comfyUiReachable;
  return Object.freeze(report);
}

module.exports = Object.freeze({ createEnvironmentReport });
