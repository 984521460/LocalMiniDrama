const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CREDENTIAL_REF = /^credential:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u
const MODEL = /^[a-z0-9][a-z0-9._/-]*$/u
const VOICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const COLOR = /^#[0-9a-f]{6}$/u
const PROVIDERS = Object.freeze(['openai-compatible', 'minimax'])
const EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'fearful', 'surprised'])

function invalid() {
  throw new TypeError('Voice profile configuration data is invalid')
}

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true
  }
  return false
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid()
  }
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== expectedKeys.length) invalid()
  const output = Object.create(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    output[key] = descriptor.value
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string' || !includes(expectedKeys, keys[index])) invalid()
  }
  return output
}

function denseArray(value, maximumLength) {
  if (!Array.isArray(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid()
  }
  if (prototype !== Array.prototype) invalid()
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength
    || Reflect.ownKeys(descriptors).length !== length + 1) invalid()
  const output = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    output[index] = descriptor.value
  }
  return output
}

function codePointLength(value, maximum) {
  let length = 0
  for (let index = 0; index < value.length;) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) invalid()
      index += 2
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff) invalid()
      index += 1
    }
    length += 1
    if (length > maximum) invalid()
  }
  return length
}

function boundedText(value, maximum, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')
    || value.trim() !== value || codePointLength(value, maximum) < 1
    || (pattern && !pattern.test(value))) invalid()
  return value
}

function uid(value, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !UUID_V4.test(value)) invalid()
  return value
}

function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function safeProviderValue(value, maximum, pattern) {
  const result = boundedText(value, maximum, pattern)
  const lowered = result.toLowerCase()
  if (/^(?:bearer\s|sk-[a-z0-9]{8}|akia[a-z0-9]{12}|-----begin\s.*private key-----)/u.test(lowered)) {
    invalid()
  }
  return result
}

function colorAnchors(value) {
  const values = denseArray(value, 16)
  const output = []
  for (let index = 0; index < values.length; index += 1) {
    const anchor = boundedText(values[index], 7, COLOR)
    if (includes(output, anchor)) invalid()
    output[index] = anchor
  }
  return Object.freeze(output)
}

function identityMetadata(value) {
  const input = exactObject(value, ['name', 'visualSignature', 'colorAnchors'])
  return Object.freeze({
    name: boundedText(input.name, 120),
    visualSignature: boundedText(input.visualSignature, 4000),
    colorAnchors: colorAnchors(input.colorAnchors),
  })
}

function voiceMetadata(value) {
  const input = exactObject(value, ['name', 'language', 'style'])
  return Object.freeze({
    name: boundedText(input.name, 120),
    language: boundedText(input.language, 16, LANGUAGE),
    style: boundedText(input.style, 1000),
  })
}

export function characterIdentityVersionView(value) {
  const input = exactObject(value, [
    'schemaVersion', 'kind', 'uid', 'characterUid', 'parentUid', 'metadata',
    'createdAtEpochMs',
  ])
  const recordUid = uid(input.uid)
  const parentUid = uid(input.parentUid, true)
  if (input.schemaVersion !== '5.0' || input.kind !== 'identity' || parentUid === recordUid) invalid()
  return Object.freeze({
    schemaVersion: '5.0', kind: 'identity', uid: recordUid,
    characterUid: uid(input.characterUid), parentUid,
    metadata: identityMetadata(input.metadata),
    createdAtEpochMs: integer(input.createdAtEpochMs, 0, 253402300799999),
  })
}

export function characterVoiceVersionView(value) {
  const input = exactObject(value, [
    'schemaVersion', 'kind', 'uid', 'characterUid', 'identityVersionUid',
    'parentUid', 'metadata', 'createdAtEpochMs',
  ])
  const recordUid = uid(input.uid)
  const parentUid = uid(input.parentUid, true)
  if (input.schemaVersion !== '5.0' || input.kind !== 'voice' || parentUid === recordUid) invalid()
  return Object.freeze({
    schemaVersion: '5.0', kind: 'voice', uid: recordUid,
    characterUid: uid(input.characterUid),
    identityVersionUid: uid(input.identityVersionUid), parentUid,
    metadata: voiceMetadata(input.metadata),
    createdAtEpochMs: integer(input.createdAtEpochMs, 0, 253402300799999),
  })
}

function emotionMapView(value) {
  const input = exactObject(value, EMOTIONS)
  const output = Object.create(null)
  for (let index = 0; index < EMOTIONS.length; index += 1) {
    const emotion = EMOTIONS[index]
    output[emotion] = safeProviderValue(input[emotion], 64, VOICE_KEY)
  }
  return Object.freeze(output)
}

function embeddedVoiceVersionView(value, expectedUid) {
  const input = exactObject(value, [
    'uid', 'identityVersionUid', 'parentUid', 'name', 'language', 'style',
    'createdAtEpochMs',
  ])
  if (input.uid !== expectedUid || input.parentUid === input.uid) invalid()
  return Object.freeze({
    uid: uid(input.uid), identityVersionUid: uid(input.identityVersionUid),
    parentUid: uid(input.parentUid, true), name: boundedText(input.name, 120),
    language: boundedText(input.language, 16, LANGUAGE),
    style: boundedText(input.style, 1000),
    createdAtEpochMs: integer(input.createdAtEpochMs, 0, 253402300799999),
  })
}

export function voiceProfileView(value) {
  const input = exactObject(value, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'characterVoiceVersionUid',
    'parentUid', 'revision', 'provider', 'model', 'voiceKey', 'sourceKind', 'status',
    'defaultEmotion', 'emotionMap', 'minimumSpeedPermille', 'defaultSpeedPermille',
    'maximumSpeedPermille', 'voiceVersion', 'credentialConfigured', 'createdAtEpochMs',
  ])
  if (input.schemaVersion !== '8.0' || !includes(PROVIDERS, input.provider)
    || input.sourceKind !== 'provider-preset' || input.status !== 'ready'
    || !includes(EMOTIONS, input.defaultEmotion) || input.credentialConfigured !== true) invalid()
  const profileUid = uid(input.uid)
  const parentUid = uid(input.parentUid, true)
  const voiceVersionUid = uid(input.characterVoiceVersionUid)
  const minimumSpeedPermille = integer(input.minimumSpeedPermille, 500, 2000)
  const defaultSpeedPermille = integer(input.defaultSpeedPermille, 500, 2000)
  const maximumSpeedPermille = integer(input.maximumSpeedPermille, 500, 2000)
  if (parentUid === profileUid || minimumSpeedPermille > defaultSpeedPermille
    || defaultSpeedPermille > maximumSpeedPermille) invalid()
  return Object.freeze({
    schemaVersion: '8.0', uid: profileUid, dramaUid: uid(input.dramaUid),
    characterUid: uid(input.characterUid), characterVoiceVersionUid: voiceVersionUid,
    parentUid, revision: integer(input.revision, 1), provider: input.provider,
    model: safeProviderValue(input.model, 128, MODEL),
    voiceKey: safeProviderValue(input.voiceKey, 128, VOICE_KEY),
    sourceKind: 'provider-preset', status: 'ready', defaultEmotion: input.defaultEmotion,
    emotionMap: emotionMapView(input.emotionMap), minimumSpeedPermille,
    defaultSpeedPermille, maximumSpeedPermille,
    voiceVersion: embeddedVoiceVersionView(input.voiceVersion, voiceVersionUid),
    credentialConfigured: true,
    createdAtEpochMs: integer(input.createdAtEpochMs, 0, 253402300799999),
  })
}

export function voiceProfileActivationView(value) {
  const input = exactObject(value, ['profileUid', 'stateVersion', 'changedAtEpochMs'])
  return Object.freeze({
    profileUid: uid(input.profileUid), stateVersion: integer(input.stateVersion, 1),
    changedAtEpochMs: integer(input.changedAtEpochMs, 0, 253402300799999),
  })
}

export function voiceProfileActivationResultView(value) {
  const input = exactObject(value, ['selection', 'profile'])
  const selection = exactObject(input.selection, [
    'schemaVersion', 'uid', 'dramaUid', 'characterUid', 'voiceProfileUid',
    'previousVoiceProfileUid', 'stateVersion', 'changedAtEpochMs',
  ])
  if (selection.schemaVersion !== '8.0') invalid()
  const profile = voiceProfileView(input.profile)
  const result = Object.freeze({
    schemaVersion: '8.0', uid: uid(selection.uid), dramaUid: uid(selection.dramaUid),
    characterUid: uid(selection.characterUid), voiceProfileUid: uid(selection.voiceProfileUid),
    previousVoiceProfileUid: uid(selection.previousVoiceProfileUid, true),
    stateVersion: integer(selection.stateVersion, 1),
    changedAtEpochMs: integer(selection.changedAtEpochMs, 0, 253402300799999),
  })
  if (result.dramaUid !== profile.dramaUid || result.characterUid !== profile.characterUid
    || result.voiceProfileUid !== profile.uid
    || result.previousVoiceProfileUid === result.voiceProfileUid) invalid()
  return Object.freeze({ selection: result, profile })
}

function records(value, maximum, view) {
  const input = denseArray(value, maximum)
  const output = []
  for (let index = 0; index < input.length; index += 1) output[index] = view(input[index])
  return Object.freeze(output)
}

export function voiceProfileConfigurationView(value) {
  const input = exactObject(value, [
    'schemaVersion', 'dramaUid', 'characterUid', 'identityVersions', 'voiceVersions',
    'profiles', 'active',
  ])
  if (input.schemaVersion !== 'voice-profile-configuration.v1') invalid()
  const dramaUid = uid(input.dramaUid)
  const characterUid = uid(input.characterUid)
  const identityVersions = records(input.identityVersions, 10000, characterIdentityVersionView)
  const voiceVersions = records(input.voiceVersions, 10000, characterVoiceVersionView)
  const profiles = records(input.profiles, 10000, voiceProfileView)
  const identityByUid = Object.create(null)
  for (let index = 0; index < identityVersions.length; index += 1) {
    const identity = identityVersions[index]
    if (identity.characterUid !== characterUid || Object.hasOwn(identityByUid, identity.uid)) invalid()
    identityByUid[identity.uid] = identity
  }
  const voiceByUid = Object.create(null)
  for (let index = 0; index < voiceVersions.length; index += 1) {
    const voice = voiceVersions[index]
    if (voice.characterUid !== characterUid || !Object.hasOwn(identityByUid, voice.identityVersionUid)
      || Object.hasOwn(voiceByUid, voice.uid)) invalid()
    voiceByUid[voice.uid] = voice
  }
  validateVersionParents(identityVersions, identityByUid, false)
  validateVersionParents(voiceVersions, voiceByUid, true)
  const profileByUid = Object.create(null)
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]
    const voice = voiceByUid[profile.characterVoiceVersionUid]
    if (profile.dramaUid !== dramaUid || profile.characterUid !== characterUid || !voice
      || Object.hasOwn(profileByUid, profile.uid)
      || profile.voiceVersion.identityVersionUid !== voice.identityVersionUid
      || profile.voiceVersion.parentUid !== voice.parentUid
      || profile.voiceVersion.name !== voice.metadata.name
      || profile.voiceVersion.language !== voice.metadata.language
      || profile.voiceVersion.style !== voice.metadata.style
      || profile.voiceVersion.createdAtEpochMs !== voice.createdAtEpochMs) invalid()
    profileByUid[profile.uid] = profile
  }
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]
    if (profile.revision === 1) {
      if (profile.parentUid !== null) invalid()
    } else {
      const parent = profileByUid[profile.parentUid]
      if (!parent || parent.revision !== profile.revision - 1
        || parent.createdAtEpochMs > profile.createdAtEpochMs) invalid()
    }
  }
  const active = input.active === null ? null : voiceProfileActivationView(input.active)
  if (active !== null) {
    let found = false
    for (let index = 0; index < profiles.length; index += 1) {
      if (profiles[index].uid === active.profileUid) found = true
    }
    if (!found) invalid()
  }
  return Object.freeze({
    schemaVersion: 'voice-profile-configuration.v1', dramaUid, characterUid,
    identityVersions, voiceVersions, profiles, active,
  })
}

function validateVersionParents(records, byUid, bindIdentity) {
  for (let index = 0; index < records.length; index += 1) {
    const seen = Object.create(null)
    let current = records[index]
    while (current.parentUid !== null) {
      if (Object.hasOwn(seen, current.uid)) invalid()
      seen[current.uid] = true
      const parent = byUid[current.parentUid]
      if (!parent || parent.createdAtEpochMs > current.createdAtEpochMs
        || (bindIdentity && parent.identityVersionUid !== current.identityVersionUid)) invalid()
      current = parent
    }
  }
}

export function createIdentityVersionRequest(value) {
  const input = exactObject(value, [
    'parentUid', 'expectedVersionCount', 'name', 'visualSignature', 'colorAnchors',
  ])
  return Object.freeze({
    parent_uid: uid(input.parentUid, true),
    expected_version_count: integer(input.expectedVersionCount, 0),
    name: boundedText(input.name, 120),
    visual_signature: boundedText(input.visualSignature, 4000),
    color_anchors: colorAnchors(input.colorAnchors),
  })
}

export function createVoiceVersionRequest(value) {
  const input = exactObject(value, [
    'identityVersionUid', 'parentUid', 'expectedVersionCount', 'name', 'language', 'style',
  ])
  return Object.freeze({
    identity_version_uid: uid(input.identityVersionUid),
    parent_uid: uid(input.parentUid, true),
    expected_version_count: integer(input.expectedVersionCount, 0),
    name: boundedText(input.name, 120),
    language: boundedText(input.language, 16, LANGUAGE),
    style: boundedText(input.style, 1000),
  })
}

export function createVoiceProfileRequest(value) {
  const input = exactObject(value, [
    'characterVoiceVersionUid', 'parentUid', 'expectedRevision', 'provider', 'model',
    'voiceKey', 'credentialRef', 'defaultEmotion', 'emotionMap', 'minimumSpeedPermille',
    'defaultSpeedPermille', 'maximumSpeedPermille',
  ])
  if (!includes(PROVIDERS, input.provider) || !includes(EMOTIONS, input.defaultEmotion)) invalid()
  const minimumSpeedPermille = integer(input.minimumSpeedPermille, 500, 2000)
  const defaultSpeedPermille = integer(input.defaultSpeedPermille, 500, 2000)
  const maximumSpeedPermille = integer(input.maximumSpeedPermille, 500, 2000)
  if (minimumSpeedPermille > defaultSpeedPermille
    || defaultSpeedPermille > maximumSpeedPermille) invalid()
  if (typeof input.credentialRef !== 'string' || !CREDENTIAL_REF.test(input.credentialRef)) invalid()
  return Object.freeze({
    character_voice_version_uid: uid(input.characterVoiceVersionUid),
    parent_uid: uid(input.parentUid, true),
    expected_revision: integer(input.expectedRevision, 0), provider: input.provider,
    model: safeProviderValue(input.model, 128, MODEL),
    voice_key: safeProviderValue(input.voiceKey, 128, VOICE_KEY),
    credential_ref: input.credentialRef, default_emotion: input.defaultEmotion,
    emotion_map: emotionMapView(input.emotionMap), minimum_speed_permille: minimumSpeedPermille,
    default_speed_permille: defaultSpeedPermille,
    maximum_speed_permille: maximumSpeedPermille,
  })
}

export function createVoiceProfileActivationRequest(value) {
  const input = exactObject(value, ['expectedStateVersion'])
  return Object.freeze({ expected_state_version: integer(input.expectedStateVersion, 0) })
}

export function voiceConfigurationPath(dramaUid, characterUid) {
  return `/v2/dramas/${encodeURIComponent(uid(dramaUid))}/characters/${encodeURIComponent(uid(characterUid))}`
}

export function voiceProfileUidPath(profileUid) {
  return encodeURIComponent(uid(profileUid))
}
