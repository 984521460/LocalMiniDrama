'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { types: { isPromise, isProxy } } = require('node:util');

const { CHARACTER_REFERENCE_ITEM_KINDS } = require('../../assets/characterReferencePackage');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2/errors');
const {
  createExecutionPromise,
  observeExecutionPromise,
  rejectExecutionPromise,
  settleProviderPromise,
} = require('../execution/asyncControl');
const { MAX_IMAGE_BYTES } = require('../execution/boundedImageSource');
const { createCharacterCandidateImageNormalizer } = require('../execution/imageNormalizer');
const {
  CharacterCandidateSourceError,
  createCharacterCandidateSourceResolver,
} = require('../execution/sourceResolver');
const { createCharacterReferencePackagePrompt } = require('./prompt');
const {
  characterReferencePackageExecutionRequestSha256,
  parseCharacterReferencePackageExecutionRequest,
} = require('./request');

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAP_DELETE = Map.prototype.delete;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const PROVIDER_KEYS = Object.freeze(['scope', 'isAvailable', 'generate']);
const TRUSTED_ERRORS = new WeakSet();
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

class CharacterReferencePackageExecutionError extends Error {
  constructor(code) {
    super('Character reference package execution failed');
    this.name = 'CharacterReferencePackageExecutionError';
    this.code = code;
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function isCharacterReferencePackageExecutionError(value) {
  return TRUSTED_ERRORS.has(value);
}

function fail(code) {
  throw new CharacterReferencePackageExecutionError(code);
}

function exactProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Character reference package provider is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(descriptors).length !== PROVIDER_KEYS.length) {
    throw new TypeError('Character reference package provider is invalid');
  }
  for (let index = 0; index < PROVIDER_KEYS.length; index += 1) {
    const key = PROVIDER_KEYS[index];
    if (!Object.hasOwn(descriptors, key) || !descriptors[key].enumerable
      || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError('Character reference package provider is invalid');
    }
  }
  if (descriptors.scope.value !== 'configured-image'
    || typeof descriptors.isAvailable.value !== 'function'
    || typeof descriptors.generate.value !== 'function'
    || isProxy(descriptors.isAvailable.value) || isProxy(descriptors.generate.value)) {
    throw new TypeError('Character reference package provider is invalid');
  }
  return Object.freeze({
    scope: descriptors.scope.value,
    isAvailable: descriptors.isAvailable.value,
    generate: descriptors.generate.value,
  });
}

function exactStorage(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError('Character reference package storage is invalid');
  }
  function method(name) {
    let cursor = value;
    while (cursor !== null) {
      if (isProxy(cursor)) throw new TypeError('Character reference package storage is invalid');
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
          || isProxy(descriptor.value)) {
          throw new TypeError('Character reference package storage is invalid');
        }
        return (...args) => Reflect.apply(descriptor.value, value, args);
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    throw new TypeError('Character reference package storage is invalid');
  }
  return Object.freeze({
    readBounded: method('readBounded'),
    remove: method('remove'),
    write: method('write'),
  });
}

function providerOutput(value, ordinal, seed, width, height, referenceImageSha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ['provider', 'model', 'parameters', 'bytes'];
  if (Reflect.ownKeys(descriptors).length !== keys.length) {
    fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
  }
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    if (!Object.hasOwn(descriptors, keys[index])) {
      fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
    }
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
    }
    output[keys[index]] = descriptor.value;
  }
  if (typeof output.provider !== 'string' || !TOKEN.test(output.provider)
    || typeof output.model !== 'string' || output.model !== output.model.trim()
    || Buffer.byteLength(output.model, 'utf8') < 1 || Buffer.byteLength(output.model, 'utf8') > 128
    || !output.parameters || typeof output.parameters !== 'object'
    || Array.isArray(output.parameters) || isProxy(output.parameters)) {
    fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
  }
  const parameters = Object.getOwnPropertyDescriptors(output.parameters);
  if (Object.getPrototypeOf(output.parameters) !== Object.prototype
    || Reflect.ownKeys(parameters).length !== 5
    || parameters.adapter?.value !== 'configured-image.v1'
    || parameters.size?.value !== `${width}x${height}`
    || parameters.requestedSeed?.value !== seed
    || parameters.ordinal?.value !== ordinal
    || parameters.referenceImageSha256?.value !== referenceImageSha256) {
    fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
  }
  return Object.freeze({
    provider: output.provider,
    model: output.model,
    bytes: output.bytes,
  });
}

function derivedSeed(seed, ordinal) {
  return (seed + ordinal * 2_654_435_761) % 4_294_967_296;
}

function boundedText(parts, fallback, maximum = 4000) {
  const values = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (typeof parts[index] === 'string' && parts[index].trim().length > 0) {
      values[values.length] = parts[index].trim();
    }
  }
  const text = values.join('；') || fallback;
  return Array.from(text).slice(0, maximum).join('');
}

function createCharacterReferencePackageExecutionService({
  repositories,
  candidateExecution,
  provider,
  storage,
  createUid = randomUUID,
  nowEpochMs = Date.now,
  normalizeImage = createCharacterCandidateImageNormalizer(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!repositories?.characterReferencePackages || !repositories?.characterReferencePackageExecutions
    || !repositories?.characterVersions
    || !repositories?.characterCandidates || !repositories?.characterCandidateExecutions
    || !repositories?.assets || typeof repositories.withTransaction !== 'function'
    || !candidateExecution || typeof candidateExecution.get !== 'function'
    || typeof createUid !== 'function' || typeof nowEpochMs !== 'function'
    || typeof normalizeImage !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new TypeError('Character reference package execution dependencies are invalid');
  }
  const configuredProvider = exactProvider(provider);
  const localStorage = exactStorage(storage);
  const active = new Map();

  function sourceFrom(current, request) {
    let execution;
    let batch;
    let source;
    try {
      execution = current.characterCandidateExecutions.get(request.candidateExecutionUid);
      if (execution.state !== 'succeeded' || execution.request.dramaUid !== request.dramaUid
        || execution.request.characterUid !== request.characterUid
        || execution.batchUid !== execution.operationUid) throw new CharacterCandidateSourceError();
      const resolved = createCharacterCandidateSourceResolver({ repositories: current })
        .resolve(execution.request);
      if (resolved.sourceSha256 !== execution.sourceSha256) throw new CharacterCandidateSourceError();
      source = resolved.source;
      batch = current.characterCandidates.getBatch(execution.batchUid);
    } catch (error) {
      if (error instanceof CharacterCandidateSourceError
        || error instanceof V2RepositoryNotFoundError
        || error instanceof V2RepositoryDataError) {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE');
      }
      throw error;
    }
    let candidate = null;
    for (let index = 0; index < batch.candidates.length; index += 1) {
      const currentCandidate = batch.candidates[index];
      if (currentCandidate.uid === request.candidateUid) candidate = currentCandidate;
    }
    if (!candidate || batch.characterUid !== request.characterUid) {
      fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE');
    }
    let asset;
    let version;
    try {
      version = current.assets.getVersion(candidate.assetVersionUid);
      asset = current.assets.get(version.assetUid);
    } catch (error) {
      if (error instanceof V2RepositoryNotFoundError
        || error instanceof V2RepositoryDataError) {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE');
      }
      throw error;
    }
    if (version.storageProvider !== 'local' || version.logicalUri !== candidate.logicalUri
      || version.sha256 !== candidate.contentSha256 || version.mimeType !== candidate.mediaType
      || version.width !== candidate.width || version.height !== candidate.height
      || version.status !== 'ready' || typeof version.relativePath !== 'string'
      || asset.ownerType !== 'character' || asset.ownerUid !== request.characterUid
      || asset.assetType !== 'character_candidate' || asset.status !== 'ready'
      || asset.currentVersionUid !== version.uid) {
      fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE');
    }
    return Object.freeze({ execution, source, candidate, version });
  }

  async function verifiedSource(request) {
    try { await candidateExecution.get(request.candidateExecutionUid); } catch {
      return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE');
    }
    return sourceFrom(repositories, request);
  }

  async function clean(locators) {
    let complete = true;
    for (let index = 0; index < locators.length; index += 1) {
      try { await localStorage.remove(locators[index]); } catch { complete = false; }
    }
    return complete;
  }

  async function readCandidateReference(current) {
    let bytes;
    try {
      bytes = await localStorage.readBounded(Object.freeze({
        storageProvider: 'local',
        relativePath: current.version.relativePath,
        logicalUri: current.version.logicalUri,
      }), MAX_IMAGE_BYTES);
      if (!Buffer.isBuffer(bytes) || isProxy(bytes)
        || Object.getPrototypeOf(bytes) !== Buffer.prototype
        || bytes.length < 1
        || createHash('sha256').update(bytes).digest('hex') !== current.candidate.contentSha256) {
        throw new TypeError();
      }
      return bytes;
    } catch (error) {
      if (Buffer.isBuffer(bytes) && !isProxy(bytes)) bytes.fill(0);
      throw new CharacterCandidateSourceError();
    }
  }

  async function verify(items) {
    for (let index = 0; index < items.length; index += 1) {
      let bytes;
      try {
        bytes = await localStorage.readBounded(items[index].locator, MAX_IMAGE_BYTES);
        if (!Buffer.isBuffer(bytes) || isProxy(bytes)
          || bytes.length !== items[index].byteLength
          || createHash('sha256').update(bytes).digest('hex') !== items[index].contentSha256) {
          throw new TypeError();
        }
      } catch {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID');
      } finally {
        if (Buffer.isBuffer(bytes) && !isProxy(bytes)) bytes.fill(0);
      }
    }
  }

  async function verifyPackage(packageRecord) {
    for (let index = 0; index < packageRecord.items.length; index += 1) {
      const item = packageRecord.items[index];
      let bytes;
      try {
        const version = repositories.assets.getVersion(item.assetVersionUid);
        if (version.storageProvider !== 'local' || version.logicalUri !== item.logicalUri
          || version.sha256 !== item.contentSha256 || typeof version.relativePath !== 'string') {
          throw new TypeError();
        }
        bytes = await localStorage.readBounded(Object.freeze({
          storageProvider: 'local',
          relativePath: version.relativePath,
          logicalUri: version.logicalUri,
        }), MAX_IMAGE_BYTES);
        if (!Buffer.isBuffer(bytes) || isProxy(bytes)
          || createHash('sha256').update(bytes).digest('hex') !== item.contentSha256) {
          throw new TypeError();
        }
      } catch {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID');
      } finally {
        if (Buffer.isBuffer(bytes) && !isProxy(bytes)) bytes.fill(0);
      }
    }
  }

  function translatedGet(operationUid) {
    try {
      return repositories.characterReferencePackageExecutions.get(operationUid);
    } catch (error) {
      if (error instanceof V2RepositoryNotFoundError) return null;
      if (error instanceof V2RepositoryDataError) {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID');
      }
      throw error;
    }
  }

  async function terminal(execution) {
    if (execution.state === 'succeeded') {
      let packageRecord;
      try { packageRecord = repositories.characterReferencePackages.get(execution.packageUid); } catch {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID');
      }
      await verifyPackage(packageRecord);
      return Object.freeze({ package: packageRecord });
    }
    if (execution.state === 'failed') fail(execution.errorCode);
    if (execution.state === 'submission_unknown') {
      fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
    }
    return null;
  }

  function transition(operationUid, method, errorCode) {
    try {
      return errorCode === undefined
        ? repositories.characterReferencePackageExecutions[method](operationUid)
        : repositories.characterReferencePackageExecutions[method](operationUid, errorCode);
    } catch {
      return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID');
    }
  }

  async function run(request) {
    const requestSha256 = characterReferencePackageExecutionRequestSha256(request);
    const prior = translatedGet(request.operationUid);
    if (prior) {
      if (prior.requestSha256 !== requestSha256) {
        fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT');
      }
      const result = await terminal(prior);
      if (result) return result;
      fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_IN_PROGRESS');
    }
    let available = false;
    try { available = Reflect.apply(configuredProvider.isAvailable, configuredProvider, []) === true; } catch {}
    if (!available) fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_UNAVAILABLE');
    const initial = await verifiedSource(request);
    const startingLock = repositories.characterCandidates.getLockState(request.characterUid);
    if (startingLock.status !== 'unlocked') fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT');
    let reservation;
    try {
      reservation = repositories.characterReferencePackageExecutions.reserve({
        request,
        candidateExecution: initial.execution,
        candidate: initial.candidate,
      });
    } catch (error) {
      if (error instanceof V2RepositoryConflictError) {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT');
      }
      if (error instanceof V2RepositoryDataError) {
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID');
      }
      throw error;
    }
    const reservedTerminal = await terminal(reservation.execution);
    if (reservedTerminal) return reservedTerminal;
    if (!reservation.created) fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_IN_PROGRESS');

    const locators = [];
    const items = [];
    const hashes = new Set();
    for (let ordinal = 0; ordinal < CHARACTER_REFERENCE_ITEM_KINDS.length; ordinal += 1) {
      const current = await verifiedSource(request);
      if (current.execution.sourceSha256 !== initial.execution.sourceSha256
        || current.candidate.contentSha256 !== initial.candidate.contentSha256) {
        const cleaned = await clean(locators);
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE' : undefined,
        );
        return fail(cleaned
          ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE'
          : 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      const kind = CHARACTER_REFERENCE_ITEM_KINDS[ordinal];
      const seed = derivedSeed(request.seed, ordinal);
      const prompt = createCharacterReferencePackagePrompt(initial.source, initial.candidate, kind);
      let generated;
      let referenceBytes;
      try {
        referenceBytes = await readCandidateReference(current);
      } catch {
        const cleaned = await clean(locators);
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE' : undefined,
        );
        return fail(cleaned
          ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE'
          : 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      try {
        generated = Reflect.apply(configuredProvider.generate, configuredProvider, [Object.freeze({
          schemaVersion: 'character-reference-package-generation-command.v1',
          operationUid: request.operationUid,
          ordinal,
          prompt: prompt.prompt,
          promptSha256: prompt.promptSha256,
          width: request.width,
          height: request.height,
          seed,
          referenceImage: Object.freeze({
            mimeType: current.candidate.mediaType,
            contentSha256: current.candidate.contentSha256,
            bytes: referenceBytes,
          }),
        })]);
        if (!isPromise(generated)) throw new TypeError();
        generated = await settleProviderPromise(generated, timeoutMs);
      } catch {
        await clean(locators);
        transition(request.operationUid, 'markUnknown');
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
      } finally {
        if (Buffer.isBuffer(referenceBytes) && !isProxy(referenceBytes)) referenceBytes.fill(0);
      }
      try {
        const output = providerOutput(
          generated,
          ordinal,
          seed,
          request.width,
          request.height,
          current.candidate.contentSha256,
        );
        const normalized = await normalizeImage(output.bytes, request.width, request.height);
        if (Reflect.apply(SET_HAS, hashes, [normalized.contentSha256])) throw new TypeError();
        Reflect.apply(SET_ADD, hashes, [normalized.contentSha256]);
        const relativePath = `characters/${request.characterUid}/reference-packages/${request.operationUid}/${kind}.png`;
        const logicalUri = `asset://characters/${request.characterUid}/reference-packages/${request.operationUid}/${kind}`;
        const locator = Object.freeze({ storageProvider: 'local', relativePath, logicalUri });
        await localStorage.write(locator, normalized.bytes);
        locators[locators.length] = locator;
        items[items.length] = Object.freeze({
          ordinal,
          kind,
          locator,
          relativePath,
          logicalUri,
          contentSha256: normalized.contentSha256,
          byteLength: normalized.bytes.length,
          assetUid: createUid(),
          assetVersionUid: createUid(),
          itemUid: createUid(),
        });
      } catch (error) {
        const cleaned = await clean(locators);
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID' : undefined,
        );
        return fail(cleaned
          ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID'
          : 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
      }
    }
    try { await verify(items); } catch (error) {
      const cleaned = await clean(locators);
      transition(
        request.operationUid,
        cleaned ? 'fail' : 'markUnknown',
        cleaned ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_OUTPUT_INVALID' : undefined,
      );
      if (!cleaned) return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
      throw error;
    }
    try {
      const current = await verifiedSource(request);
      if (current.execution.sourceSha256 !== initial.execution.sourceSha256
        || current.candidate.contentSha256 !== initial.candidate.contentSha256) {
        throw new CharacterCandidateSourceError();
      }
    } catch {
      const cleaned = await clean(locators);
      transition(
        request.operationUid,
        cleaned ? 'fail' : 'markUnknown',
        cleaned ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE' : undefined,
      );
      return fail(cleaned
        ? 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE'
        : 'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
    }

    const identityUid = createUid();
    const appearanceUid = createUid();
    const costumeUid = createUid();
    const lockEventUid = createUid();
    const createdAtEpochMs = nowEpochMs();
    let packageRecord;
    try {
      packageRecord = repositories.withTransaction((scoped) => {
        const current = sourceFrom(scoped, request);
        if (current.execution.sourceSha256 !== initial.execution.sourceSha256
          || current.candidate.contentSha256 !== initial.candidate.contentSha256) {
          throw new CharacterCandidateSourceError();
        }
        const lockBefore = scoped.characterCandidates.getLockState(request.characterUid);
        if (lockBefore.status !== 'unlocked'
          || lockBefore.stateVersion !== startingLock.stateVersion) {
          throw new V2RepositoryConflictError('character identity lock', 'changed');
        }
        const visual = boundedText([
          initial.source.characterAppearance,
          initial.source.characterFactDescription,
          initial.source.characterDescription,
        ], initial.source.characterName);
        const identity = scoped.characterVersions.create({
          schemaVersion: '5.0', kind: 'identity', uid: identityUid,
          characterUid: request.characterUid, parentUid: null,
          metadata: {
            name: `${initial.source.characterName}锁定身份`,
            visualSignature: visual,
            colorAnchors: ['#1f2937', '#d6a77a'],
          },
          createdAtEpochMs,
        });
        const appearance = scoped.characterVersions.create({
          schemaVersion: '5.0', kind: 'appearance', uid: appearanceUid,
          characterUid: request.characterUid, identityVersionUid: identity.uid, parentUid: null,
          metadata: {
            name: '默认外貌', description: visual, colorAnchors: ['#1f2937', '#d6a77a'],
          },
          createdAtEpochMs,
        });
        const costume = scoped.characterVersions.create({
          schemaVersion: '5.0', kind: 'costume', uid: costumeUid,
          characterUid: request.characterUid, identityVersionUid: identity.uid, parentUid: null,
          metadata: {
            name: '默认服装',
            description: boundedText([initial.source.characterAppearance], '以锁定候选为准的默认服装'),
            colorAnchors: ['#374151', '#f3f4f6'],
          },
          createdAtEpochMs,
        });
        const lock = scoped.characterCandidates.lock({
          eventUid: lockEventUid,
          characterUid: request.characterUid,
          candidateUid: request.candidateUid,
          identityVersionUid: identity.uid,
          expectedStateVersion: startingLock.stateVersion,
          changedAtEpochMs: createdAtEpochMs,
        });
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          scoped.assets.create({
            uid: item.assetUid,
            ownerType: 'character',
            ownerUid: request.characterUid,
            assetType: 'character_reference',
            status: 'draft',
          });
          scoped.assets.addVersion({
            uid: item.assetVersionUid,
            assetUid: item.assetUid,
            storageProvider: 'local',
            logicalUri: item.logicalUri,
            relativePath: item.relativePath,
            sha256: item.contentSha256,
            mimeType: 'image/png',
            width: request.width,
            height: request.height,
            durationMs: null,
            parentUid: null,
            status: 'ready',
          }, { makeCurrent: true });
        }
        const storedPackage = scoped.characterReferencePackages.create({
          packageUid: request.operationUid,
          characterUid: request.characterUid,
          appearanceVersionUid: appearance.uid,
          costumeVersionUid: costume.uid,
          expectedLockStateVersion: lock.stateVersion,
          createdAtEpochMs,
          items: items.map((item) => ({
            uid: item.itemUid,
            ordinal: item.ordinal,
            kind: item.kind,
            assetVersionUid: item.assetVersionUid,
          })),
        });
        scoped.characterReferencePackageExecutions.complete(
          request.operationUid,
          storedPackage.packageUid,
        );
        return storedPackage;
      });
    } catch (error) {
      const cleaned = await clean(locators);
      if (!cleaned) {
        transition(request.operationUid, 'markUnknown');
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      if (error instanceof CharacterCandidateSourceError) {
        transition(
          request.operationUid,
          'fail',
          'CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE',
        );
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_SOURCE_STALE');
      }
      if (error instanceof V2RepositoryConflictError) {
        transition(
          request.operationUid,
          'fail',
          'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
        );
        return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT');
      }
      transition(
        request.operationUid,
        'fail',
        'CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID',
      );
      return fail('CHARACTER_REFERENCE_PACKAGE_EXECUTION_DATA_INVALID');
    }
    repositories.characterReferencePackageExecutions.get(request.operationUid);
    return Object.freeze({ package: packageRecord });
  }

  return Object.freeze({
    execute(value) {
      let request;
      try { request = parseCharacterReferencePackageExecutionRequest(value); } catch {
        return rejectExecutionPromise(new CharacterReferencePackageExecutionError(
          'CHARACTER_REFERENCE_PACKAGE_EXECUTION_INPUT_INVALID',
        ));
      }
      const requestSha256 = characterReferencePackageExecutionRequestSha256(request);
      const running = Reflect.apply(MAP_GET, active, [request.operationUid]);
      if (running) {
        if (running.requestSha256 !== requestSha256) {
          return rejectExecutionPromise(new CharacterReferencePackageExecutionError(
            'CHARACTER_REFERENCE_PACKAGE_EXECUTION_CONFLICT',
          ));
        }
        return running.promise;
      }
      let resolveExecution;
      let rejectExecution;
      const promise = createExecutionPromise((resolve, reject) => {
        resolveExecution = resolve;
        rejectExecution = reject;
      });
      Reflect.apply(MAP_SET, active, [request.operationUid, Object.freeze({ promise, requestSha256 })]);
      const finish = (callback, output) => {
        Reflect.apply(MAP_DELETE, active, [request.operationUid]);
        callback(output);
      };
      try {
        observeExecutionPromise(
          run(request),
          (output) => finish(resolveExecution, output),
          (error) => finish(rejectExecution, error),
        );
      } catch (error) {
        finish(rejectExecution, error);
      }
      return promise;
    },
  });
}

module.exports = Object.freeze({
  CharacterReferencePackageExecutionError,
  createCharacterReferencePackageExecutionService,
  isCharacterReferencePackageExecutionError,
});
