const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z.+:_-]{0,127}$/u
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/u
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const EVIDENCE_REF = /^phase-(?:1|7):[a-z0-9]+(?:-[a-z0-9]+)*$/u

function fail() {
  throw new TypeError('H3 status data is invalid')
}

function jsonData(value) {
  if (typeof value !== 'string' || value.length > 1048576) fail()
  try {
    return parseStrictJson(value)
  } catch {
    fail()
  }
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  let descriptors
  let prototype
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    fail()
  }
  if (prototype !== Object.prototype && prototype !== null) fail()
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) fail()
  const output = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    output[key] = descriptor.value
  }
  return output
}

function denseArray(value, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength
    || Reflect.ownKeys(descriptors).length !== length + 1) fail()
  const output = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    output.push(descriptor.value)
  }
  return output
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail()
  return value
}

function number(value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail()
  return value
}

function text(value, pattern, maximumLength = 256) {
  if (typeof value !== 'string' || value.length > maximumLength || !pattern.test(value)) fail()
  return value
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function modelView(value) {
  const input = exactObject(value, [
    'nodeType', 'inputName', 'fileName', 'sha256', 'bytes', 'digestStatus',
  ])
  if (!['verified', 'historical-evidence-malformed'].includes(input.digestStatus)) fail()
  const sha256 = input.sha256 === null ? null : text(input.sha256, SHA256, 64)
  if ((input.digestStatus === 'verified') !== (sha256 !== null)) fail()
  return {
    nodeType: text(input.nodeType, TOKEN, 128),
    inputName: text(input.inputName, TOKEN, 128),
    fileName: text(input.fileName, FILE_NAME, 255),
    sha256,
    bytes: integer(input.bytes, 1, 100000000000),
    digestStatus: input.digestStatus,
  }
}

const MODE_SPECS = Object.freeze({
  t2v: Object.freeze({ roles: [], minimum: 0, maximum: 0, realValidation: 'validated-rtx4090' }),
  'fl2va-first': Object.freeze({ roles: ['first'], minimum: 1, maximum: 1, realValidation: 'validated-rtx4090' }),
  'fl2va-first-last': Object.freeze({ roles: ['first', 'last'], minimum: 2, maximum: 2, realValidation: 'validated-rtx4090' }),
  ref2va: Object.freeze({ roles: ['reference'], minimum: 1, maximum: 4, realValidation: 'validated-rtx4090' }),
})

const RTX4090_T2V_MEASURED_CASES = Object.freeze([
  Object.freeze({
    caseId: 'h3-client-smoke',
    requestedSeconds: 0.2,
    width: 608,
    height: 352,
    fps: 24,
    frames: 5,
    videoCodec: 'h264',
    audioCodec: 'aac',
    outputSha256: 'd8d9af12a1ea45fe054308dd83ad7183421471fd3fbb534b54f7e10c425e29cf',
    evidenceRef: 'phase-1:h3-client-smoke',
  }),
  Object.freeze({
    caseId: 'h3-fight-15s',
    requestedSeconds: 15,
    width: 608,
    height: 352,
    fps: 24,
    frames: 362,
    videoCodec: 'h264',
    audioCodec: 'aac',
    outputSha256: '4fc449c09f34efbe7955e056f4108ae36c469097f70e93480996f0a8fadd8ecf',
    evidenceRef: 'phase-1:h3-fight-15s',
  }),
  Object.freeze({
    caseId: 'h3-real-t2v',
    requestedSeconds: 1.625,
    width: 608,
    height: 352,
    fps: 24,
    frames: 39,
    videoCodec: 'h264',
    audioCodec: 'aac',
    outputSha256: '49aa825a1f8c20e5c3a71038ec795aa28ec2fab3e07a14eb316ee632f462f525',
    evidenceRef: 'phase-7:h3-real-t2v',
  }),
])

const RTX4090_FL2VA_FIRST_MEASURED_CASES = Object.freeze([Object.freeze({
  caseId: 'h3-real-fl2va-first', requestedSeconds: 1.625, width: 608, height: 352,
  fps: 24, frames: 39, videoCodec: 'h264', audioCodec: 'aac',
  outputSha256: '63cb57efe4cb466c3ce8b479a1239aff510baa63891959cabf1bdcf4b94e8f9a',
  evidenceRef: 'phase-7:h3-real-fl2va-first',
})])

const RTX4090_FL2VA_FIRST_LAST_MEASURED_CASES = Object.freeze([Object.freeze({
  caseId: 'h3-real-fl2va-first-last', requestedSeconds: 1.625, width: 608, height: 352,
  fps: 24, frames: 39, videoCodec: 'h264', audioCodec: 'aac',
  outputSha256: 'd65c380d207d5a35ef484af2135b0fbbac0df95230f00f4cad53efd4272537ae',
  evidenceRef: 'phase-7:h3-real-fl2va-first-last',
})])

const RTX4090_REF2VA_MEASURED_CASES = Object.freeze([Object.freeze({
  caseId: 'h3-real-ref2va', requestedSeconds: 1.625, width: 608, height: 352,
  fps: 24, frames: 39, videoCodec: 'h264', audioCodec: 'aac',
  outputSha256: '7fa3e5f46c95a06c6f144afd4663425c1a1af2c2a5f28974f4fb7baab86d3033',
  evidenceRef: 'phase-7:h3-real-ref2va',
})])

function modeView(value, mode) {
  const input = exactObject(value, [
    'referenceImageRoles', 'minimumReferenceImages', 'maximumReferenceImages',
    'nativeAudioOutput', 'realValidation',
  ])
  const spec = MODE_SPECS[mode]
  const roles = denseArray(input.referenceImageRoles, 4)
  if (roles.length !== spec.roles.length
    || roles.some((role, index) => role !== spec.roles[index])
    || input.minimumReferenceImages !== spec.minimum
    || input.maximumReferenceImages !== spec.maximum
    || input.nativeAudioOutput !== true
    || input.realValidation !== spec.realValidation) fail()
  return {
    referenceImageRoles: roles,
    minimumReferenceImages: spec.minimum,
    maximumReferenceImages: spec.maximum,
    nativeAudioOutput: true,
    realValidation: spec.realValidation,
  }
}

export function h3ProfileView(value) {
  const input = exactObject(jsonData(value), [
    'schemaVersion', 'uid', 'profileId', 'revision', 'engine', 'modelFamily',
    'sourceRevision', 'fps', 'frameGrid', 'canvas', 'sampler', 'models', 'modes',
  ])
  if (input.schemaVersion !== 'h3-profile.v1'
    || input.profileId !== 'minimax-h3-local-four-step-768p'
    || input.revision !== 2 || input.engine !== 'comfyui'
    || input.modelFamily !== 'minimax-h3' || input.fps !== 24) fail()
  const frameGrid = exactObject(input.frameGrid, ['offset', 'stride', 'minimum'])
  if (frameGrid.offset !== 5 || frameGrid.stride !== 17 || frameGrid.minimum !== 5) fail()
  const canvas = exactObject(input.canvas, [
    'multipleOf', 'maximumLongEdge', 'maximumShortEdge', 'maximumPixels',
  ])
  if (canvas.multipleOf !== 32 || canvas.maximumLongEdge !== 1344
    || canvas.maximumShortEdge !== 768 || canvas.maximumPixels !== 1032192) fail()
  const sampler = exactObject(input.sampler, [
    'steps', 'samplerName', 'scheduler', 'denoise', 'loraStrength',
  ])
  if (sampler.steps !== 4 || sampler.samplerName !== 'res_multistep'
    || sampler.scheduler !== 'simple' || sampler.denoise !== 1
    || sampler.loraStrength !== 1) fail()
  const models = exactObject(input.models, [
    'diffusion', 'textEncoder', 'videoVae', 'audioVae', 'turboLora',
  ])
  const modes = exactObject(input.modes, Object.keys(MODE_SPECS))
  return deepFreeze({
    schemaVersion: input.schemaVersion,
    uid: text(input.uid, UUID_V4, 36),
    profileId: input.profileId,
    revision: input.revision,
    engine: input.engine,
    modelFamily: input.modelFamily,
    sourceRevision: text(input.sourceRevision, /^[0-9a-f]{40}$/u, 40),
    fps: input.fps,
    frameGrid: { offset: 5, stride: 17, minimum: 5 },
    canvas: {
      multipleOf: 32, maximumLongEdge: 1344, maximumShortEdge: 768,
      maximumPixels: 1032192,
    },
    sampler: {
      steps: 4, samplerName: 'res_multistep', scheduler: 'simple', denoise: 1,
      loraStrength: 1,
    },
    models: {
      diffusion: modelView(models.diffusion),
      textEncoder: modelView(models.textEncoder),
      videoVae: modelView(models.videoVae),
      audioVae: modelView(models.audioVae),
      turboLora: modelView(models.turboLora),
    },
    modes: Object.fromEntries(Object.keys(MODE_SPECS).map((mode) => [
      mode, modeView(modes[mode], mode),
    ])),
  })
}

function measuredCaseView(value) {
  const input = exactObject(value, [
    'caseId', 'requestedSeconds', 'width', 'height', 'fps', 'frames',
    'videoCodec', 'audioCodec', 'outputSha256', 'evidenceRef',
  ])
  if (input.fps !== 24 || input.videoCodec !== 'h264' || input.audioCodec !== 'aac') fail()
  return {
    caseId: text(input.caseId, CASE_ID, 64),
    requestedSeconds: number(input.requestedSeconds, 0.01, 15),
    width: integer(input.width, 32, 1344),
    height: integer(input.height, 32, 1344),
    fps: 24,
    frames: integer(input.frames, 5, 362),
    videoCodec: 'h264',
    audioCodec: 'aac',
    outputSha256: text(input.outputSha256, SHA256, 64),
    evidenceRef: text(input.evidenceRef, EVIDENCE_REF, 128),
  }
}

function validationModeView(value, expectedStatus, expectedCases = []) {
  const input = exactObject(value, ['status', 'measuredCases'])
  if (input.status !== expectedStatus) fail()
  const measuredCases = denseArray(input.measuredCases, 16).map(measuredCaseView)
  if (measuredCases.length !== expectedCases.length
    || measuredCases.some((measuredCase, index) => (
      Object.keys(expectedCases[index]).some((key) => measuredCase[key] !== expectedCases[index][key])
    ))) fail()
  return { status: input.status, measuredCases }
}

function gpuView(value, expectedClass, expectedVram, verifiedRtx4090) {
  const input = exactObject(value, ['gpuClass', 'vramGiB', 'modes'])
  if (input.gpuClass !== expectedClass || input.vramGiB !== expectedVram) fail()
  const modes = exactObject(input.modes, Object.keys(MODE_SPECS))
  return {
    gpuClass: input.gpuClass,
    vramGiB: input.vramGiB,
    modes: {
      t2v: validationModeView(
        modes.t2v,
        verifiedRtx4090 ? 'verified' : 'unverified',
        verifiedRtx4090 ? RTX4090_T2V_MEASURED_CASES : [],
      ),
      'fl2va-first': validationModeView(
        modes['fl2va-first'],
        verifiedRtx4090 ? 'verified' : 'unverified',
        verifiedRtx4090 ? RTX4090_FL2VA_FIRST_MEASURED_CASES : [],
      ),
      'fl2va-first-last': validationModeView(
        modes['fl2va-first-last'],
        verifiedRtx4090 ? 'verified' : 'unverified',
        verifiedRtx4090 ? RTX4090_FL2VA_FIRST_LAST_MEASURED_CASES : [],
      ),
      ref2va: validationModeView(
        modes.ref2va,
        verifiedRtx4090 ? 'verified' : 'unverified',
        verifiedRtx4090 ? RTX4090_REF2VA_MEASURED_CASES : [],
      ),
    },
  }
}

export function h3RealValidationMatrixView(value, expectedProfileUid) {
  const input = exactObject(jsonData(value), ['schemaVersion', 'profileUid', 'gpus'])
  if (input.schemaVersion !== 'h3-real-validation-matrix.v1'
    || input.profileUid !== expectedProfileUid || !UUID_V4.test(input.profileUid)) fail()
  const gpus = denseArray(input.gpus, 2)
  if (gpus.length !== 2) fail()
  return deepFreeze({
    schemaVersion: input.schemaVersion,
    profileUid: input.profileUid,
    gpus: [
      gpuView(gpus[0], RTX_4090_GPU_CLASS, RTX_4090_VRAM_GIB, true),
      gpuView(gpus[1], RTX_PRO_6000_GPU_CLASS, RTX_PRO_6000_VRAM_GIB, false),
    ],
  })
}

export function h3ExecutionIntentView(value) {
  const input = exactObject(jsonData(value), [
    'schemaVersion', 'uid', 'taskUid', 'generationRunUid', 'historyUid',
    'assetUid', 'manifestUid', 'parentVersionUid', 'createdAtEpochMs',
  ])
  if (input.schemaVersion !== 'h3-local-execution-intent.v1') fail()
  const parentVersionUid = input.parentVersionUid === null
    ? null
    : text(input.parentVersionUid, UUID_V4, 36)
  return deepFreeze({
    schemaVersion: input.schemaVersion,
    uid: text(input.uid, UUID_V4, 36),
    taskUid: text(input.taskUid, UUID_V4, 36),
    generationRunUid: text(input.generationRunUid, UUID_V4, 36),
    historyUid: text(input.historyUid, UUID_V4, 36),
    assetUid: text(input.assetUid, UUID_V4, 36),
    manifestUid: text(input.manifestUid, UUID_V4, 36),
    parentVersionUid,
    createdAtEpochMs: integer(input.createdAtEpochMs, 0, 253402300799999),
  })
}
import { parseStrictJson } from '../security/strictJson.js'
import {
  RTX_4090_GPU_CLASS,
  RTX_4090_VRAM_GIB,
  RTX_PRO_6000_GPU_CLASS,
  RTX_PRO_6000_VRAM_GIB,
} from './gpuClasses.js'
