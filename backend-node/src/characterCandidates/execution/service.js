'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { types: { isPromise, isProxy } } = require('node:util');

const { createCharacterCandidateBatch } = require('../../assets/characterCandidateBatch');
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
} = require('./asyncControl');
const { MAX_IMAGE_BYTES } = require('./boundedImageSource');
const { createCharacterCandidateImageNormalizer } = require('./imageNormalizer');
const {
  MANIFEST,
  MANIFEST_JSON,
  MANIFEST_SHA256,
  PROFILE,
  PROFILE_JSON,
  PROFILE_SHA256,
} = require('./profile');
const { createCharacterCandidatePrompt } = require('./prompt');
const {
  characterCandidateExecutionRequestSha256,
  parseCharacterCandidateExecutionRequest,
} = require('./request');
const {
  CharacterCandidateSourceError,
  createCharacterCandidateSourceResolver,
} = require('./sourceResolver');

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const MAP_DELETE = Map.prototype.delete;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const STRING_INCLUDES = String.prototype.includes;
const STRING_TRIM = String.prototype.trim;
const PROVIDER_KEYS = Object.freeze(['scope', 'isAvailable', 'generate']);
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRUSTED_ERRORS = new WeakSet();

class CharacterCandidateExecutionError extends Error {
  constructor(code) {
    super('Character candidate execution failed');
    this.name = 'CharacterCandidateExecutionError';
    this.code = code;
    TRUSTED_ERRORS.add(this);
    Object.freeze(this);
  }
}

function isCharacterCandidateExecutionError(value) {
  return TRUSTED_ERRORS.has(value);
}

function fail(code) {
  throw new CharacterCandidateExecutionError(code);
}

function exactProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Character candidate provider is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || keys.length !== 3) throw new TypeError('Character candidate provider is invalid');
  for (let index = 0; index < PROVIDER_KEYS.length; index += 1) {
    const key = PROVIDER_KEYS[index];
    if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError('Character candidate provider is invalid');
    }
  }
  if (descriptors.scope.value !== 'configured-image'
    || typeof descriptors.isAvailable.value !== 'function'
    || typeof descriptors.generate.value !== 'function'
    || isProxy(descriptors.isAvailable.value) || isProxy(descriptors.generate.value)) {
    throw new TypeError('Character candidate provider is invalid');
  }
  return Object.freeze({
    scope: descriptors.scope.value,
    isAvailable: descriptors.isAvailable.value,
    generate: descriptors.generate.value,
  });
}

function exactStorage(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError('Character candidate storage is invalid');
  }
  function method(name) {
    let cursor = value;
    while (cursor !== null) {
      if (isProxy(cursor)) throw new TypeError('Character candidate storage is invalid');
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
          || isProxy(descriptor.value)) {
          throw new TypeError('Character candidate storage is invalid');
        }
        return (...args) => Reflect.apply(descriptor.value, value, args);
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    throw new TypeError('Character candidate storage is invalid');
  }
  return Object.freeze({
    readBounded: method('readBounded'),
    remove: method('remove'),
    write: method('write'),
  });
}

function providerOutput(value, ordinal, seed, width, height) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch {
    return fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
  }
  const keys = ['provider', 'model', 'parameters', 'bytes'];
  if (Reflect.ownKeys(descriptors).length !== keys.length) {
    fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
  }
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
    }
    output[keys[index]] = descriptor.value;
  }
  if (typeof output.provider !== 'string' || !TOKEN.test(output.provider)
    || typeof output.model !== 'string' || Buffer.byteLength(output.model, 'utf8') < 1
    || Buffer.byteLength(output.model, 'utf8') > 128
    || Reflect.apply(STRING_TRIM, output.model, []) !== output.model
    || Reflect.apply(STRING_INCLUDES, output.model, ['\0'])
    || !output.parameters || typeof output.parameters !== 'object'
    || Array.isArray(output.parameters) || isProxy(output.parameters)) {
    fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
  }
  const parameters = Object.getOwnPropertyDescriptors(output.parameters);
  if (Object.getPrototypeOf(output.parameters) !== Object.prototype
    || Reflect.ownKeys(parameters).length !== 4
    || parameters.adapter?.value !== 'configured-image.v1'
    || parameters.size?.value !== `${width}x${height}`
    || parameters.requestedSeed?.value !== seed
    || parameters.ordinal?.value !== ordinal) fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
  const parameterKeys = ['adapter', 'size', 'requestedSeed', 'ordinal'];
  for (let index = 0; index < parameterKeys.length; index += 1) {
    const descriptor = parameters[parameterKeys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID');
    }
  }
  return Object.freeze({
    provider: output.provider,
    model: output.model,
    parameters: Object.freeze({
      adapter: 'configured-image.v1',
      size: parameters.size.value,
      requestedSeed: seed,
      ordinal,
    }),
    bytes: output.bytes,
  });
}

function parameterJson(parameters) {
  return `{"adapter":"configured-image.v1","size":${JSON.stringify(parameters.size)}`
    + `,"requestedSeed":${parameters.requestedSeed},"ordinal":${parameters.ordinal}}`;
}

function derivedSeed(seed, ordinal) {
  return (seed + ordinal * 2_654_435_761) % 4_294_967_296;
}

function createCharacterCandidateExecutionService({
  repositories,
  provider,
  storage,
  createUid = randomUUID,
  normalizeImage = createCharacterCandidateImageNormalizer(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!repositories?.characterCandidateExecutions || !repositories?.characterCandidates
    || !repositories?.assets || typeof repositories?.withTransaction !== 'function'
    || typeof createUid !== 'function' || typeof normalizeImage !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new TypeError('Character candidate execution dependencies are invalid');
  }
  const configuredProvider = exactProvider(provider);
  const localStorage = exactStorage(storage);
  const resolver = createCharacterCandidateSourceResolver({ repositories });
  const active = new Map();

  function currentSource(currentRepositories, request) {
    if (currentRepositories === repositories) return resolver.resolve(request);
    return createCharacterCandidateSourceResolver({ repositories: currentRepositories }).resolve(request);
  }

  function translatedGet(operationUid) {
    try { return repositories.characterCandidateExecutions.get(operationUid); } catch (error) {
      if (error instanceof V2RepositoryNotFoundError) return null;
      if (error instanceof V2RepositoryDataError) fail('CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID');
      throw error;
    }
  }

  async function verifyMedia(items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const locator = Object.freeze({
        storageProvider: 'local',
        logicalUri: item.logicalUri
          || `asset://characters/${item.characterUid}/candidate-batches/${item.operationUid}/${item.ordinal}`,
        relativePath: item.relativePath,
      });
      let bytes;
      try {
        bytes = await localStorage.readBounded(locator, MAX_IMAGE_BYTES);
        if (isProxy(bytes) || !Buffer.isBuffer(bytes)
          || Object.getPrototypeOf(bytes) !== Buffer.prototype
          || bytes.length !== item.byteLength
          || createHash('sha256').update(bytes).digest('hex') !== item.contentSha256) {
          throw new TypeError('Character candidate media evidence is invalid');
        }
      } catch {
        fail('CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID');
      } finally {
        if (Buffer.isBuffer(bytes) && !isProxy(bytes)) bytes.fill(0);
      }
    }
  }

  async function terminal(execution) {
    if (execution.state === 'succeeded') {
      let source;
      let batch;
      try {
        source = currentSource(repositories, execution.request);
        batch = repositories.characterCandidates.getBatch(execution.batchUid);
      } catch (error) {
        if (error instanceof CharacterCandidateSourceError
          || error instanceof V2RepositoryNotFoundError
          || error instanceof V2RepositoryDataError) {
          return fail('CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE');
        }
        throw error;
      }
      if (source.sourceSha256 !== execution.sourceSha256
        || batch.batchUid !== execution.operationUid) {
        fail('CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE');
      }
      await verifyMedia(execution.items);
      return Object.freeze({ execution, batch });
    }
    if (execution.state === 'failed') fail(execution.errorCode);
    if (execution.state === 'submission_unknown') {
      fail('CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
    }
    return null;
  }

  function transition(operationUid, method, code) {
    try { return repositories.characterCandidateExecutions[method](operationUid, code); } catch {
      return fail('CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID');
    }
  }

  async function clean(locators) {
    let cleanResult = true;
    for (let index = 0; index < locators.length; index += 1) {
      try { await localStorage.remove(locators[index]); } catch { cleanResult = false; }
    }
    return cleanResult;
  }

  async function run(request) {
    const requestSha256 = characterCandidateExecutionRequestSha256(request);
    const prior = translatedGet(request.operationUid);
    if (prior !== null) {
      if (prior.requestSha256 !== requestSha256) fail('CHARACTER_CANDIDATE_EXECUTION_CONFLICT');
      const result = await terminal(prior);
      if (result) return result;
      fail('CHARACTER_CANDIDATE_EXECUTION_IN_PROGRESS');
    }
    let available = false;
    try { available = Reflect.apply(configuredProvider.isAvailable, configuredProvider, []) === true; } catch {}
    if (!available) fail('CHARACTER_CANDIDATE_EXECUTION_UNAVAILABLE');

    let resolved;
    try { resolved = currentSource(repositories, request); } catch (error) {
      if (error instanceof CharacterCandidateSourceError) {
        return fail('CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE');
      }
      throw error;
    }
    let reservation;
    try {
      reservation = repositories.characterCandidateExecutions.reserve({
        request,
        requestSha256,
        source: resolved.source,
        sourceSha256: resolved.sourceSha256,
        profileJson: PROFILE_JSON,
        profileSha256: PROFILE_SHA256,
        manifestJson: MANIFEST_JSON,
        manifestSha256: MANIFEST_SHA256,
      });
    } catch (error) {
      if (error instanceof V2RepositoryConflictError) fail('CHARACTER_CANDIDATE_EXECUTION_CONFLICT');
      if (error instanceof V2RepositoryDataError) fail('CHARACTER_CANDIDATE_EXECUTION_DATA_INVALID');
      throw error;
    }
    const reservedTerminal = await terminal(reservation.execution);
    if (reservedTerminal) return reservedTerminal;
    if (!reservation.created) fail('CHARACTER_CANDIDATE_EXECUTION_IN_PROGRESS');

    const installed = [];
    const items = [];
    const hashes = new Set();
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      try {
        const current = currentSource(repositories, request);
        if (current.sourceSha256 !== resolved.sourceSha256) throw new CharacterCandidateSourceError();
      } catch (error) {
        const cleaned = await clean(installed);
        if (!(error instanceof CharacterCandidateSourceError)) {
          transition(request.operationUid, 'markUnknown');
          return fail('CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
        }
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE' : undefined,
        );
        return fail(cleaned
          ? 'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE'
          : 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      const seed = derivedSeed(request.seed, ordinal);
      const prompt = createCharacterCandidatePrompt(resolved.source, ordinal, seed);
      let generated;
      try {
        generated = Reflect.apply(configuredProvider.generate, configuredProvider, [{
          schemaVersion: 'character-candidate-generation-command.v1',
          operationUid: request.operationUid,
          ordinal,
          prompt: prompt.prompt,
          promptSha256: prompt.promptSha256,
          width: request.width,
          height: request.height,
          seed,
        }]);
        if (!isPromise(generated)) throw new TypeError();
        generated = await settleProviderPromise(generated, timeoutMs);
      } catch {
        await clean(installed);
        transition(request.operationUid, 'markUnknown');
        return fail('CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      let normalized;
      let evidence;
      try {
        const output = providerOutput(generated, ordinal, seed, request.width, request.height);
        normalized = await normalizeImage(output.bytes, request.width, request.height);
        if (Reflect.apply(SET_HAS, hashes, [normalized.contentSha256])) throw new TypeError();
        Reflect.apply(SET_ADD, hashes, [normalized.contentSha256]);
        const relativePath = `characters/${request.characterUid}/candidate-batches/${request.operationUid}/${ordinal}.png`;
        const logicalUri = `asset://characters/${request.characterUid}/candidate-batches/${request.operationUid}/${ordinal}`;
        const locator = Object.freeze({ storageProvider: 'local', logicalUri, relativePath });
        await localStorage.write(locator, normalized.bytes);
        installed[installed.length] = locator;
        evidence = Object.freeze({
          ordinal,
          seed,
          promptSha256: prompt.promptSha256,
          provider: output.provider,
          model: output.model,
          parametersJson: parameterJson(output.parameters),
          relativePath,
          contentSha256: normalized.contentSha256,
          bytes: normalized.bytes.length,
          candidateUid: createUid(),
          assetUid: createUid(),
          assetVersionUid: createUid(),
        });
      } catch {
        const cleaned = await clean(installed);
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID' : undefined,
        );
        return fail(cleaned
          ? 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID'
          : 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      items[items.length] = evidence;
    }

    try {
      const installedEvidence = [];
      for (let index = 0; index < items.length; index += 1) {
        installedEvidence[index] = Object.freeze({
          ...items[index],
          byteLength: items[index].bytes,
          logicalUri: `asset://characters/${request.characterUid}/candidate-batches/${request.operationUid}/${items[index].ordinal}`,
        });
      }
      await verifyMedia(installedEvidence);
    } catch {
      const cleaned = await clean(installed);
      transition(
        request.operationUid,
        cleaned ? 'fail' : 'markUnknown',
        cleaned ? 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID' : undefined,
      );
      return fail(cleaned
        ? 'CHARACTER_CANDIDATE_EXECUTION_OUTPUT_INVALID'
        : 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
    }

    const candidates = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      candidates[candidates.length] = {
        uid: item.candidateUid,
        ordinal: item.ordinal,
        assetVersionUid: item.assetVersionUid,
        logicalUri: `asset://characters/${request.characterUid}/candidate-batches/${request.operationUid}/${item.ordinal}`,
        mediaType: 'image/png',
        width: request.width,
        height: request.height,
        contentSha256: item.contentSha256,
        presentation: 'single_portrait',
      };
    }
    const batch = createCharacterCandidateBatch({
      schemaVersion: '5.0',
      batchUid: request.operationUid,
      characterUid: request.characterUid,
      promptSemanticUid: request.extractionResultUid,
      profileUid: PROFILE.uid,
      manifestUid: MANIFEST.uid,
      width: request.width,
      height: request.height,
      seed: request.seed,
      candidateCount: 4,
    }, {
      candidates,
    });

    let committed;
    try {
      committed = repositories.withTransaction((scoped) => {
        const current = currentSource(scoped, request);
        if (current.sourceSha256 !== resolved.sourceSha256) throw new CharacterCandidateSourceError();
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          scoped.assets.create({
            uid: item.assetUid,
            ownerType: 'character',
            ownerUid: request.characterUid,
            assetType: 'character_candidate',
            status: 'draft',
          });
          scoped.assets.addVersion({
            uid: item.assetVersionUid,
            assetUid: item.assetUid,
            storageProvider: 'local',
            logicalUri: `asset://characters/${request.characterUid}/candidate-batches/${request.operationUid}/${item.ordinal}`,
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
        const storedBatch = scoped.characterCandidates.appendBatch(batch);
        const execution = scoped.characterCandidateExecutions.complete(
          request.operationUid,
          storedBatch.batchUid,
          items,
        );
        return Object.freeze({ execution, batch: storedBatch });
      });
    } catch (error) {
      const cleaned = await clean(installed);
      if (error instanceof CharacterCandidateSourceError) {
        transition(
          request.operationUid,
          cleaned ? 'fail' : 'markUnknown',
          cleaned ? 'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE' : undefined,
        );
        return fail(cleaned
          ? 'CHARACTER_CANDIDATE_EXECUTION_SOURCE_STALE'
          : 'CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
      }
      transition(request.operationUid, 'markUnknown');
      return fail('CHARACTER_CANDIDATE_EXECUTION_SUBMISSION_UNKNOWN');
    }
    return terminal(committed.execution);
  }

  return Object.freeze({
    execute(value) {
      let request;
      try { request = parseCharacterCandidateExecutionRequest(value); } catch {
        return rejectExecutionPromise(
          new CharacterCandidateExecutionError('CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID'),
        );
      }
      const requestSha256 = characterCandidateExecutionRequestSha256(request);
      const existing = Reflect.apply(MAP_GET, active, [request.operationUid]);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          return rejectExecutionPromise(
            new CharacterCandidateExecutionError('CHARACTER_CANDIDATE_EXECUTION_CONFLICT'),
          );
        }
        return existing.promise;
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

    async get(operationUid) {
      if (typeof operationUid !== 'string' || !UUID_V4.test(operationUid)) {
        fail('CHARACTER_CANDIDATE_EXECUTION_INPUT_INVALID');
      }
      const execution = translatedGet(operationUid);
      if (execution === null) fail('CHARACTER_CANDIDATE_EXECUTION_NOT_FOUND');
      return await terminal(execution) || Object.freeze({ execution, batch: null });
    },
  });
}

module.exports = Object.freeze({
  CharacterCandidateExecutionError,
  createCharacterCandidateExecutionService,
  isCharacterCandidateExecutionError,
});
