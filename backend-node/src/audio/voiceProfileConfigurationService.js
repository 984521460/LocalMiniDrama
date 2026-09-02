'use strict';

const { randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { createVersionValidation } = require('../assets/versionValidation');
const {
  createProviderCredentialView,
} = require('../credentials/providerCredential');
const {
  isComfyAsyncControlError,
  raceNativePromise,
} = require('../integrations/comfyui/asyncControl');
const {
  getWindowsCredentialErrorCode,
} = require('../adapters/v2/credentials/windowsCredentialVault');
const {
  createVoiceProfileActivationRequest,
  createVoiceProfilePublicRecord,
  createVoiceProfileRequest,
} = require('./voiceProfile');
const {
  createV2Repositories,
  V2RepositoryConflictError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2');

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_MESSAGE = 'Voice profile configuration input is invalid';
const errorCodes = new WeakMap();
const {
  canonicalUid,
  colorAnchors,
  exactObject,
  requiredString,
} = createVersionValidation(ERROR_MESSAGE);

function configurationError(code) {
  const error = new Error('Voice profile configuration failed');
  errorCodes.set(error, code);
  return error;
}

function getVoiceProfileConfigurationErrorCode(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || isProxy(error)) {
    return null;
  }
  return errorCodes.get(error) ?? null;
}

function dataMethod(value, name) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    return null;
  }
  let target = value;
  for (let depth = 0; target && depth < 4; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(target, name); } catch { return null; }
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value')
        && typeof descriptor.value === 'function'
        && !isProxy(descriptor.value) ? descriptor.value : null;
    }
    try { target = Object.getPrototypeOf(target); } catch { return null; }
  }
  return null;
}

function expectedCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(ERROR_MESSAGE);
  return value;
}

function identityRequest(value) {
  const input = exactObject(value, [
    'parent_uid', 'expected_version_count', 'name', 'visual_signature', 'color_anchors',
  ]);
  return Object.freeze({
    parentUid: canonicalUid(input.parent_uid, true),
    expectedVersionCount: expectedCount(input.expected_version_count),
    metadata: Object.freeze({
      name: requiredString(input.name, 120),
      visualSignature: requiredString(input.visual_signature, 4000),
      colorAnchors: colorAnchors(input.color_anchors),
    }),
  });
}

function voiceRequest(value) {
  const input = exactObject(value, [
    'identity_version_uid', 'parent_uid', 'expected_version_count',
    'name', 'language', 'style',
  ]);
  return Object.freeze({
    identityVersionUid: canonicalUid(input.identity_version_uid),
    parentUid: canonicalUid(input.parent_uid, true),
    expectedVersionCount: expectedCount(input.expected_version_count),
    metadata: Object.freeze({
      name: requiredString(input.name, 120),
      language: requiredString(input.language, 16),
      style: requiredString(input.style, 1000),
    }),
  });
}

function freezeArray(values) {
  const output = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) output[index] = values[index];
  return Object.freeze(output);
}

function createVoiceProfileConfigurationService({
  database,
  credentialVault,
  createUid = randomUUID,
  createVersionUid = createUid,
  createProfileUid = createUid,
  createSelectionUid = createUid,
  nowEpochMs = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!database || typeof database.prepare !== 'function'
    || typeof createVersionUid !== 'function' || isProxy(createVersionUid)
    || typeof createProfileUid !== 'function' || isProxy(createProfileUid)
    || typeof createSelectionUid !== 'function' || isProxy(createSelectionUid)
    || typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('Voice profile configuration dependencies are invalid');
  }
  const repositories = createV2Repositories(database);
  const owner = database.prepare(`
    SELECT drama.uid AS drama_uid,character.uid AS character_uid
    FROM characters AS character
    JOIN dramas AS drama ON drama.id=character.drama_id
    WHERE drama.uid=? AND character.uid=?
      AND drama.deleted_at IS NULL AND character.deleted_at IS NULL
  `);
  const inspectMethod = dataMethod(credentialVault, 'inspect');

  function assertOwner(dramaUid, characterUid) {
    const canonicalDramaUid = canonicalUid(dramaUid);
    const canonicalCharacterUid = canonicalUid(characterUid);
    if (!owner.get(canonicalDramaUid, canonicalCharacterUid)) {
      throw new V2RepositoryNotFoundError('voice profile character');
    }
    return Object.freeze({ dramaUid: canonicalDramaUid, characterUid: canonicalCharacterUid });
  }

  async function assertCredential(ref) {
    if (!credentialVault || !inspectMethod) {
      throw configurationError('VOICE_PROFILE_CREDENTIAL_UNAVAILABLE');
    }
    try {
      const operation = Reflect.apply(inspectMethod, credentialVault, [ref]);
      const descriptor = await raceNativePromise(operation, { timeoutMs });
      const view = createProviderCredentialView(descriptor);
      if (view.ref !== ref) throw new TypeError('credential reference mismatch');
      return view;
    } catch (error) {
      const code = getWindowsCredentialErrorCode(error);
      if (code === 'CREDENTIAL_NOT_FOUND' || code === 'CREDENTIAL_VALUE_INVALID'
        || code === 'CREDENTIAL_REFERENCE_CONFLICT' || error instanceof TypeError) {
        throw configurationError('VOICE_PROFILE_CREDENTIAL_INVALID');
      }
      if (isComfyAsyncControlError(error) || code === 'CREDENTIAL_VAULT_IO_FAILED'
        || code === 'CREDENTIAL_STORE_INDETERMINATE') {
        throw configurationError('VOICE_PROFILE_CREDENTIAL_UNAVAILABLE');
      }
      throw configurationError('VOICE_PROFILE_CREDENTIAL_UNAVAILABLE');
    }
  }

  function publicState(dramaUid, characterUid) {
    const ownership = assertOwner(dramaUid, characterUid);
    const identityVersions = repositories.characterVersions.list('identity', ownership.characterUid);
    const voiceVersions = repositories.characterVersions.list('voice', ownership.characterUid);
    const internalProfiles = repositories.voiceProfiles.list(ownership.characterUid);
    const profiles = new Array(internalProfiles.length);
    for (let index = 0; index < internalProfiles.length; index += 1) {
      if (internalProfiles[index].dramaUid !== ownership.dramaUid) {
        throw new V2RepositoryNotFoundError('voice profile character');
      }
      profiles[index] = createVoiceProfilePublicRecord(internalProfiles[index]);
    }
    const selected = repositories.voiceProfiles.getActive(ownership.characterUid);
    if (selected && selected.profile.dramaUid !== ownership.dramaUid) {
      throw new V2RepositoryNotFoundError('voice profile character');
    }
    return Object.freeze({
      schemaVersion: 'voice-profile-configuration.v1',
      dramaUid: ownership.dramaUid,
      characterUid: ownership.characterUid,
      identityVersions: freezeArray(identityVersions),
      voiceVersions: freezeArray(voiceVersions),
      profiles: freezeArray(profiles),
      active: selected ? Object.freeze({
        profileUid: selected.profile.uid,
        stateVersion: selected.selection.stateVersion,
        changedAtEpochMs: selected.selection.changedAtEpochMs,
      }) : null,
    });
  }

  function getProfile(dramaUid, characterUid, profileUid) {
    const ownership = assertOwner(dramaUid, characterUid);
    const profile = repositories.voiceProfiles.get(canonicalUid(profileUid));
    if (profile.dramaUid !== ownership.dramaUid || profile.characterUid !== ownership.characterUid) {
      throw new V2RepositoryNotFoundError('voice profile');
    }
    return createVoiceProfilePublicRecord(profile);
  }

  function getActive(dramaUid, characterUid) {
    const ownership = assertOwner(dramaUid, characterUid);
    const active = repositories.voiceProfiles.getActive(ownership.characterUid);
    if (!active || active.profile.dramaUid !== ownership.dramaUid) {
      throw new V2RepositoryNotFoundError('voice profile');
    }
    return Object.freeze({
      selection: active.selection,
      profile: createVoiceProfilePublicRecord(active.profile),
    });
  }

  function createIdentityVersion(dramaUid, characterUid, value) {
    const ownership = assertOwner(dramaUid, characterUid);
    const request = identityRequest(value);
    const current = repositories.characterVersions.list('identity', ownership.characterUid);
    const expectedParent = current.length === 0 ? null : current[current.length - 1].uid;
    if (request.expectedVersionCount !== current.length || request.parentUid !== expectedParent) {
      throw new V2RepositoryConflictError('character identity version', 'created');
    }
    return repositories.characterVersions.create({
      schemaVersion: '5.0',
      kind: 'identity',
      uid: Reflect.apply(createVersionUid, null, []),
      characterUid: ownership.characterUid,
      parentUid: request.parentUid,
      metadata: request.metadata,
      createdAtEpochMs: Reflect.apply(nowEpochMs, null, []),
    });
  }

  function createVoiceVersion(dramaUid, characterUid, value) {
    const ownership = assertOwner(dramaUid, characterUid);
    const request = voiceRequest(value);
    const identities = repositories.characterVersions.list('identity', ownership.characterUid);
    let identityExists = false;
    for (let index = 0; index < identities.length; index += 1) {
      if (identities[index].uid === request.identityVersionUid) identityExists = true;
    }
    if (!identityExists) throw new V2RepositoryNotFoundError('character identity version');
    const current = repositories.characterVersions.list('voice', ownership.characterUid);
    let expectedParent = null;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index].identityVersionUid === request.identityVersionUid) {
        expectedParent = current[index].uid;
      }
    }
    if (request.expectedVersionCount !== current.length || request.parentUid !== expectedParent) {
      throw new V2RepositoryConflictError('character voice version', 'created');
    }
    return repositories.characterVersions.create({
      schemaVersion: '5.0',
      kind: 'voice',
      uid: Reflect.apply(createVersionUid, null, []),
      characterUid: ownership.characterUid,
      identityVersionUid: request.identityVersionUid,
      parentUid: request.parentUid,
      metadata: request.metadata,
      createdAtEpochMs: Reflect.apply(nowEpochMs, null, []),
    });
  }

  async function createProfile(dramaUid, characterUid, value) {
    const ownership = assertOwner(dramaUid, characterUid);
    const request = createVoiceProfileRequest(value);
    const profiles = repositories.voiceProfiles.list(ownership.characterUid);
    const expectedParent = profiles.length === 0 ? null : profiles[profiles.length - 1].uid;
    if (request.revision !== profiles.length + 1 || request.parentUid !== expectedParent) {
      throw new V2RepositoryConflictError('voice profile', 'created');
    }
    await assertCredential(request.credentialRef);
    const profile = repositories.voiceProfiles.create({
      schemaVersion: '8.0',
      uid: Reflect.apply(createProfileUid, null, []),
      dramaUid: ownership.dramaUid,
      characterUid: ownership.characterUid,
      characterVoiceVersionUid: request.characterVoiceVersionUid,
      parentUid: request.parentUid,
      revision: request.revision,
      provider: request.provider,
      model: request.model,
      voiceKey: request.voiceKey,
      credentialRef: request.credentialRef,
      sourceKind: 'provider-preset',
      status: 'ready',
      defaultEmotion: request.defaultEmotion,
      emotionMap: request.emotionMap,
      minimumSpeedPermille: request.minimumSpeedPermille,
      defaultSpeedPermille: request.defaultSpeedPermille,
      maximumSpeedPermille: request.maximumSpeedPermille,
      createdAtEpochMs: Reflect.apply(nowEpochMs, null, []),
    });
    return createVoiceProfilePublicRecord(profile);
  }

  async function activateProfile(dramaUid, characterUid, profileUid, value) {
    const ownership = assertOwner(dramaUid, characterUid);
    const canonicalProfileUid = canonicalUid(profileUid);
    const request = createVoiceProfileActivationRequest(value);
    const profile = repositories.voiceProfiles.get(canonicalProfileUid);
    if (profile.dramaUid !== ownership.dramaUid || profile.characterUid !== ownership.characterUid) {
      throw new V2RepositoryNotFoundError('voice profile');
    }
    await assertCredential(profile.credentialRef);
    const current = repositories.voiceProfiles.getActive(ownership.characterUid);
    const currentStateVersion = current?.selection.stateVersion ?? 0;
    if (request.expectedStateVersion !== currentStateVersion) {
      throw new V2RepositoryConflictError('voice profile selection', 'created');
    }
    const selection = repositories.voiceProfiles.activate({
      schemaVersion: '8.0',
      uid: Reflect.apply(createSelectionUid, null, []),
      dramaUid: ownership.dramaUid,
      characterUid: ownership.characterUid,
      voiceProfileUid: profile.uid,
      previousVoiceProfileUid: current?.profile.uid ?? null,
      stateVersion: currentStateVersion + 1,
      changedAtEpochMs: Reflect.apply(nowEpochMs, null, []),
    });
    return Object.freeze({ selection, profile: createVoiceProfilePublicRecord(profile) });
  }

  return Object.freeze({
    getState: publicState,
    getProfile,
    getActive,
    createIdentityVersion,
    createVoiceVersion,
    createProfile,
    activateProfile,
  });
}

module.exports = Object.freeze({
  createVoiceProfileConfigurationService,
  getVoiceProfileConfigurationErrorCode,
});
